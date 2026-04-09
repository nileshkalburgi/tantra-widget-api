/**
 * Tantra Widget Generator - Backend API Server (Render + PostgreSQL)
 * 
 * Optimized for Render.com deployment with PostgreSQL database
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// CRITICAL: Trust proxy for Render's load balancer
// ─────────────────────────────────────────────────────────────
app.set('trust proxy', true);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─────────────────────────────────────────────────────────────
// PostgreSQL Database Connection (Render)
// ─────────────────────────────────────────────────────────────

let db;

async function initDatabase() {
  try {
    // Render provides DATABASE_URL automatically
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Test connection
    await db.query('SELECT NOW()');

    // Create tables if they don't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id SERIAL PRIMARY KEY,
        license_key VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        plan VARCHAR(50) NOT NULL,
        credits INTEGER,
        monthly_limit INTEGER NOT NULL DEFAULT 20,
        active BOOLEAN NOT NULL DEFAULT true,
        domain VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_license_key ON licenses(license_key);
      CREATE INDEX IF NOT EXISTS idx_email ON licenses(email);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS usage_tracking (
        id SERIAL PRIMARY KEY,
        license_key VARCHAR(50) NOT NULL,
        email VARCHAR(255) NOT NULL,
        year_month VARCHAR(7) NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(license_key, year_month)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_license ON usage_tracking(license_key);
      CREATE INDEX IF NOT EXISTS idx_usage_month ON usage_tracking(year_month);
    `);

    console.log('✅ PostgreSQL connected and tables initialized');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.log('⚠️  Running without database - using in-memory storage');
    db = null;
  }
}

// In-memory fallback
const licensesMemory = new Map();
const usageMemory = new Map();

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

async function validateLicense(licenseKey) {
  try {
    if (db) {
      const result = await db.query(
        'SELECT * FROM licenses WHERE license_key = $1 AND active = true',
        [licenseKey]
      );
      
      if (result.rows.length === 0) {
        return { valid: false, error: 'Invalid license key' };
      }
      
      const license = result.rows[0];
      
      if (new Date() > new Date(license.expires_at)) {
        return { valid: false, error: 'License has expired' };
      }
      
      return { valid: true, license };
    } else {
      const license = licensesMemory.get(licenseKey);
      if (!license || !license.active) {
        return { valid: false, error: 'Invalid license key' };
      }
      if (Date.now() > license.expiresAt) {
        return { valid: false, error: 'License has expired' };
      }
      return { valid: true, license };
    }
  } catch (error) {
    console.error('License validation error:', error);
    return { valid: false, error: 'Validation error' };
  }
}

async function hasCreditsAvailable(license) {
  if (license.plan === 'agency' || license.plan === 'unlimited') {
    return true;
  }
  
  const usage = await getMonthlyUsage(license);
  const monthlyLimit = license.monthly_limit || license.monthlyLimit || 20;
  
  if (usage >= monthlyLimit) {
    return false;
  }
  
  const credits = license.credits;
  if (credits !== null && credits !== undefined && credits <= 0) {
    return false;
  }
  
  return true;
}

async function getMonthlyUsage(license) {
  try {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const licenseKey = license.license_key || license.licenseKey;
    
    if (db) {
      const result = await db.query(
        'SELECT usage_count FROM usage_tracking WHERE license_key = $1 AND year_month = $2',
        [licenseKey, yearMonth]
      );
      return result.rows.length > 0 ? result.rows[0].usage_count : 0;
    } else {
      const usageKey = `${license.email}-${yearMonth}`;
      return usageMemory.get(usageKey) || 0;
    }
  } catch (error) {
    console.error('Get usage error:', error);
    return 0;
  }
}

async function incrementUsage(license) {
  try {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const licenseKey = license.license_key || license.licenseKey;
    
    if (db) {
      await db.query(`
        INSERT INTO usage_tracking (license_key, email, year_month, usage_count)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (license_key, year_month)
        DO UPDATE SET usage_count = usage_tracking.usage_count + 1, updated_at = CURRENT_TIMESTAMP
      `, [licenseKey, license.email, yearMonth]);
      
      if (license.credits !== null && license.credits !== undefined) {
        await db.query(
          'UPDATE licenses SET credits = credits - 1 WHERE license_key = $1',
          [licenseKey]
        );
      }
    } else {
      const usageKey = `${license.email}-${yearMonth}`;
      const currentUsage = usageMemory.get(usageKey) || 0;
      usageMemory.set(usageKey, currentUsage + 1);
      if (license.credits !== undefined) {
        license.credits--;
      }
    }
  } catch (error) {
    console.error('Increment usage error:', error);
  }
}

async function generateWidgetWithClaude(prompt) {
  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  
  if (!CLAUDE_API_KEY) {
    throw new Error('Claude API key not configured');
  }
  
  const systemPrompt = `You are an expert WordPress and Elementor developer. Your task is to generate a complete, production-ready Elementor widget based on the user's description.

CRITICAL REQUIREMENTS - NEVER SKIP THESE:
1. ALWAYS start with: <?php followed by ABSPATH security check
2. The security check MUST be: if ( ! defined( 'ABSPATH' ) ) { exit; }
3. Generate ONLY complete, working PHP code - NO explanations, NO markdown, NO comments outside code
4. Code must be 100% COMPLETE - never truncate or end mid-line
5. Class must extend \\Elementor\\Widget_Base
6. Use the 'tantra-addons' category
7. Include comprehensive controls in register_controls()
8. Include styling options (colors, typography, spacing, responsive controls)
9. Use proper escaping (esc_html, esc_attr, esc_url, wp_kses_post)
10. Include inline CSS in the render() method if needed
11. Follow WordPress and Elementor coding standards
12. Make it responsive and accessible
13. Generate creative, professional widgets with good UX

TEMPLATE START:
<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

class Your_Widget_Name extends \\Elementor\\Widget_Base {
	// ... rest of widget code
}

Generate the COMPLETE widget code. Never truncate. Always end properly with closing braces.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000, // INCREASED from 4000 to prevent truncation
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Claude API error');
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '1.0.0',
    database: db ? 'connected' : 'in-memory',
    platform: 'render'
  });
});

app.post('/api/validate-license', async (req, res) => {
  const { license_key, domain } = req.body;
  
  if (!license_key) {
    return res.status(400).json({ success: false, error: 'License key is required' });
  }
  
  const validation = await validateLicense(license_key);
  if (!validation.valid) {
    return res.status(401).json({ success: false, error: validation.error });
  }
  
  const license = validation.license;
  
  if (domain && license.domain && license.domain !== domain) {
    return res.status(401).json({ success: false, error: 'License not valid for this domain' });
  }
  
  const monthlyUsage = await getMonthlyUsage(license);
  const monthlyLimit = license.monthly_limit || license.monthlyLimit || 20;
  
  res.json({
    success: true,
    license: {
      plan: license.plan,
      credits: license.credits,
      monthlyLimit: monthlyLimit,
      monthlyUsage: monthlyUsage,
      creditsRemaining: license.credits !== null ? license.credits : null,
      quotaRemaining: monthlyLimit - monthlyUsage,
      expiresAt: license.expires_at || license.expiresAt
    }
  });
});

app.post('/api/generate-widget', async (req, res) => {
  try {
    const { license_key, prompt, domain } = req.body;
    
    if (!license_key || !prompt) {
      return res.status(400).json({ success: false, error: 'License key and prompt are required' });
    }
    
    const validation = await validateLicense(license_key);
    if (!validation.valid) {
      return res.status(401).json({ success: false, error: validation.error });
    }
    
    const license = validation.license;
    
    if (domain && license.domain && license.domain !== domain) {
      return res.status(401).json({ success: false, error: 'License not valid for this domain' });
    }
    
    if (!await hasCreditsAvailable(license)) {
      return res.status(403).json({
        success: false,
        error: 'No credits or quota remaining. Please upgrade your plan.'
      });
    }
    
    const widgetCode = await generateWidgetWithClaude(prompt);
    await incrementUsage(license);
    
    console.log(`Widget generated for ${license.email} - Plan: ${license.plan}`);
    
    const monthlyUsage = await getMonthlyUsage(license);
    const monthlyLimit = license.monthly_limit || license.monthlyLimit || 20;
    
    let updatedCredits = license.credits;
    if (db && updatedCredits !== null) {
      const result = await db.query('SELECT credits FROM licenses WHERE license_key = $1', [license.license_key]);
      if (result.rows.length > 0) {
        updatedCredits = result.rows[0].credits;
      }
    }
    
    res.json({
      success: true,
      widget_code: widgetCode,
      usage: {
        credits: updatedCredits,
        monthlyUsage: monthlyUsage,
        monthlyLimit: monthlyLimit,
        creditsRemaining: updatedCredits !== null ? updatedCredits : null,
        quotaRemaining: monthlyLimit - monthlyUsage
      },
      message: 'Widget generated successfully'
    });
  } catch (error) {
    console.error('Error generating widget:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate widget. Please try again.'
    });
  }
});

app.get('/api/usage-stats', async (req, res) => {
  const { license_key } = req.query;
  
  if (!license_key) {
    return res.status(400).json({ success: false, error: 'License key is required' });
  }
  
  const validation = await validateLicense(license_key);
  if (!validation.valid) {
    return res.status(401).json({ success: false, error: validation.error });
  }
  
  const license = validation.license;
  const monthlyUsage = await getMonthlyUsage(license);
  const monthlyLimit = license.monthly_limit || license.monthlyLimit || 20;
  
  res.json({
    success: true,
    stats: {
      plan: license.plan,
      credits: license.credits,
      monthlyLimit: monthlyLimit,
      monthlyUsage: monthlyUsage,
      creditsRemaining: license.credits !== null ? license.credits : null,
      quotaRemaining: monthlyLimit - monthlyUsage,
      expiresAt: license.expires_at || license.expiresAt,
      active: license.active
    }
  });
});

app.post('/api/admin/create-license', async (req, res) => {
  const { email, plan, credits, monthlyLimit, domain } = req.body;
  
  const licenseKey = `TANTRA-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  
  try {
    if (db) {
      await db.query(`
        INSERT INTO licenses (license_key, email, plan, credits, monthly_limit, active, domain, expires_at)
        VALUES ($1, $2, $3, $4, $5, true, $6, $7)
      `, [licenseKey, email, plan || 'starter', credits || null, monthlyLimit || 20, domain || null, expiresAt]);
      
      const result = await db.query('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
      res.json({ success: true, license_key: licenseKey, license: result.rows[0] });
    } else {
      const license = {
        email,
        plan: plan || 'starter',
        credits: credits || null,
        monthlyLimit: monthlyLimit || 20,
        active: true,
        domain: domain || null,
        createdAt: Date.now(),
        expiresAt: expiresAt.getTime()
      };
      licensesMemory.set(licenseKey, license);
      res.json({ success: true, license_key: licenseKey, license });
    }
  } catch (error) {
    console.error('Create license error:', error);
    res.status(500).json({ success: false, error: 'Failed to create license' });
  }
});

app.get('/api/admin/licenses', async (req, res) => {
  try {
    if (db) {
      const result = await db.query('SELECT * FROM licenses ORDER BY created_at DESC');
      res.json({ success: true, count: result.rows.length, licenses: result.rows });
    } else {
      const allLicenses = Array.from(licensesMemory.entries()).map(([key, data]) => ({
        license_key: key,
        ...data
      }));
      res.json({ success: true, count: allLicenses.length, licenses: allLicenses });
    }
  } catch (error) {
    console.error('List licenses error:', error);
    res.status(500).json({ success: false, error: 'Failed to list licenses' });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

async function startServer() {
  await initDatabase();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 Tantra Widget Generator API Server                  ║
║                                                           ║
║   Platform: Render.com                                    ║
║   Port: ${PORT}                                              ║
║   Database: ${db ? 'PostgreSQL ✅' : 'In-Memory ⚠️'}      ║
║   Trust Proxy: ENABLED ✅                                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

startServer();
