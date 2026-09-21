# One-Sentence Accounting ✦ AI Bookkeeping

> The purpose of accounting isn't to record the past, but to change the next transaction.

One-sentence bookkeeping → Instant budget impact → Early overspending alerts → Natural language review.
Zero-dependency local prototype: Node 22 native http + fetch, JSON file storage, single-file frontend.

## What Problem Does It Solve

The real pain point of traditional accounting apps isn't "recording" but **discovering overspending when the money is already gone**.
One-Sentence Accounting moves "discovering overspending" from monthly statements to three critical moments:

| Moment | Scenario | Product Mechanism |
| --- | --- | --- |
| Before spending | Before making a purchase | Open to see "Today you can still spend ¥86" = Remaining budget ÷ Remaining days |
| During recording | When recording an expense | Instant feedback on impact: "This meal takes 14% of your food budget, enough for 6 more meals" |
| After spending | Any time | Directly ask: "How much did I spend on food this month?" "Will I overspend if I continue at this pace?" |

Plus a layer of **spending pattern prediction**: Extrapolate monthly total based on current daily average, and compare "spending progress vs time progress" — if spending speed outpaces time progress, it triggers a color warning, letting you know "at this rate, you'll overspend ¥380 by the end of the month" as early as day 3.

## Architecture: Where to Draw the LLM Boundary

```
User's one sentence
   │
   ▼
┌──────────────┐  One LLM call for intent routing
│  GLM Parser   │──▶ Bookkeeping ──▶ Whitelist validation ──▶ Save to DB ──▶ Local budget impact calculation
│ (Natural language → JSON) │──▶ Adjust budget ──▶ Validate category/amount ──▶ Locally modify budget
│              │──▶ Query ──▶ Local aggregation ──▶ LLM only organizes language for answers
└──────────────┘
```

**Core principle: LLM only does "natural language ⇄ structured data" translation. All arithmetic (budget, impact, prediction, aggregation) is done locally by deterministic code.**

Why this approach:

1. **Accuracy** — LLM arithmetic is unreliable, while a one-yuan budget difference matters
2. **Privacy** — Account details never leave your device; only aggregated results are sent to the model when querying
3. **Cost** — Prompts only contain necessary structured data, tokens spent where they matter most
4. **Testability** — Core accounting logic is pure functions, testable; all LLM outputs pass whitelist validation

## Engineering Details

- **Intent Routing**: Same input field, one LLM call identifies three intents (bookkeeping / budget adjustment / query), no mode switching needed
- **LLM Output Fault Tolerance**: Markdown code block stripping, JSON start position detection, field whitelist filtering, date format normalization (`2026-8-28` → `2026-08-28`)
- **Time Zone Pitfalls**: `toISOString()` is UTC, "today" becomes "yesterday" before 8 AM; all calculations use local time zone
- **Environment Compatibility**: Global fetch requires Node 18+, automatically falls back to native `https.request` when not detected — runs on old Node 14 machines too
- **Human-in-the-loop**: One-click undo for AI parsing results, trust but verify
- **Zero Dependencies**: Node 22 native http + fetch, clone and run, no node_modules

## Quick Start

```bash
# 1. Configure Zhipu API Key (choose one)
#    a) Environment variable: export ZHIPU_API_KEY=xxx
#    b) Create secret.json in project root: {"ZHIPU_API_KEY": "your_key"}
# 2. Start (Windows: double-click 启动记账.bat)
node server.js
# 3. Open http://localhost:3456
```

## Roadmap

- [ ] Multi-month ledgers + monthly comparisons
- [ ] Voice input (Web Speech API)
- [ ] Prediction upgrade: 7-day weighted daily average, automatic detection of one-time large expenses
- [ ] Confirmation mode for bookkeeping (configurable: confirm before saving AI-parsed results)

## Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.