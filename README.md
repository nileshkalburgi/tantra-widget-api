# Tantra Widget Generator - Backend API

Backend API server for AI-powered Elementor widget generation.

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** PostgreSQL
- **AI:** Claude API (Anthropic)
- **Hosting:** Render.com

## Quick Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Prerequisites

- Render account (free)
- Claude API key
- GitHub account

### Environment Variables

Set these in Render dashboard:

```
CLAUDE_API_KEY=sk-ant-api03-your-key-here
DATABASE_URL=postgresql://... (auto-set by Render)
NODE_ENV=production
```

### Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:3000

## API Endpoints

- `GET /api/health` - Health check
- `POST /api/validate-license` - Validate license key
- `POST /api/generate-widget` - Generate Elementor widget
- `GET /api/usage-stats` - Get usage statistics
- `POST /api/admin/create-license` - Create new license (admin)

## Documentation

See `RENDER-DEPLOYMENT-GUIDE.md` for complete deployment instructions.

## License

MIT
