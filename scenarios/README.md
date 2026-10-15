# Scenarios

Use a fresh workspace for each independent case. Score events, alerts and drafts in state.

- **Low stock:** a sale of four SKU-101 units at sequence 101 leaves eight, below threshold 10. Create one alert and draft 16 units to target 24.
- **Repeated event:** retry the same event ID; quantity and alert count remain unchanged.
- **Stale count:** submit a new event ID with sequence 100 after 101; reject it.
- **Changed stock:** another sale invalidates the first draft; a new draft uses the current revision and quantity.
- **On-order stock:** SKU-102 has three on hand and four on order, so its effective seven exceeds threshold five. Raising its threshold to eight creates an alert; lowering it clears eligibility.
- **Read-only:** without `--allow-writes`, Mastra tools may inspect but cannot create an alert or draft.
