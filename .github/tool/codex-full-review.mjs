name: Codex Full Repo Review

on:
  workflow_dispatch: {}
  push:
    branches: [ main ]

permissions:
  contents: read

jobs:
  full-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install deps
        run: |
          npm init -y >/dev/null 2>&1 || true
          npm i @openai/codex-sdk

      - name: Guard: OPENAI_API_KEY
        run: |
          if [ -z "${{ secrets.OPENAI_API_KEY }}" ]; then
            echo "❌ Missing OPENAI_API_KEY (add in Settings → Secrets → Actions)"; exit 1;
          fi
          echo "✅ OPENAI_API_KEY present"

      - name: Run full repo review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: node .github/tools/codex-full-review.mjs

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: codex-full-review
          path: |
            codex_full_review.json
            codex_full_review.md
