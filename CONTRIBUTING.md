# Contributing to Code Plan Proxy

Thank you for your interest in contributing to Code Plan Proxy! This project aims to be a robust bridge between AI coding agents and various LLM providers.

## Getting Started

### Prerequisites
- Node.js 20+
- NPM or PNPM

### Installation
1. Clone the repository.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in your API keys.

### Development
Start the development server with auto-reload:
```bash
npm run dev
```

## Project Structure

- `src/server.js`: Main entry point, API routing, and streaming logic.
- `src/converter.js`: Logic for converting between Anthropic and OpenAI API formats.
- `src/providers.js`: Configuration for different LLM providers (NVIDIA, DeepSeek, etc.).
- `src/db.js`: LowDB/JSON based data storage.
- `src/dashboard.html`: Admin dashboard UI.
- `data/`: Local storage for users and usage logs (gitignored).

## How to add a new Provider

1. Open `src/providers.js`.
2. Add a new entry to the `PROVIDERS` object.
3. Define the `endpoint`, `apiKey`, and `modelMap`.
4. Ensure `server.js` and `db.js` use the new provider name if you want it to be the default.

## Pull Request Guidelines
- Follow the existing code style (ES Modules).
- Ensure your changes work with streaming responses.
- Update the documentation if you add new features.

## License
By contributing, you agree that your contributions will be licensed under the **MIT License**.
