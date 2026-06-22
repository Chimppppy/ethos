# Budget Workflows

Budgets are local records in the `budgets` table. They are keyed by category and represent monthly limits.

## Recommended Category Set

Use a small stable set unless the user asks for more detail:

- Housing
- Utilities
- Groceries
- Dining
- Transport
- Travel
- Shopping
- Health
- Fitness
- Entertainment
- Subscriptions
- Insurance
- Debt
- Savings
- Income
- Transfers
- Fees
- Taxes
- Gifts
- Other

Plaid categories such as `FOOD_AND_DRINK` can be left as-is, or agents can map them into user categories through `tx categorize`.

## Build A First Budget

1. Sync:

   ```bash
   node cli.js sync
   ```

2. Review recent monthly spending:

   ```bash
   node cli.js report month --month YYYY-MM
   node cli.js report cashflow
   ```

3. Propose monthly limits.
4. Ask the user to confirm.
5. Write budgets:

   ```bash
   node cli.js budget set Groceries 650
   node cli.js budget set Dining 350
   node cli.js budget set Transport 250
   ```

6. Verify:

   ```bash
   node cli.js report month --month YYYY-MM
   ```

## Check Budget Status

```bash
node cli.js report month
```

Look for categories where:

```json
"over": true
```

Each category includes:

- `spent`
- `monthly_limit`
- `remaining`
- `transaction_count`
- `over`

## Categorization Cleanup

Pull uncategorized transactions:

```bash
node cli.js tx list --uncategorized --limit 50
```

The agent should group similar merchants and propose exact commands:

```bash
node cli.js tx categorize <transaction_id> Dining
node cli.js tx categorize <transaction_id> Groceries
```

Ask for confirmation before running them.

## Budget Review Prompts

Useful agent prompts:

```text
Sync my accounts and tell me which categories are over budget this month.
```

```text
Look at the last three months and propose starter budgets. Do not write anything until I confirm.
```

```text
Find uncategorized transactions and propose category fixes using the standard category set.
```

## Advanced Read-Only Budget Queries

Average monthly spend by category:

```bash
node cli.js query "SELECT category, ROUND(AVG(month_spend), 2) AS avg_month_spend FROM (SELECT month, category, SUM(amount) AS month_spend FROM v_tx WHERE amount > 0 GROUP BY month, category) GROUP BY category ORDER BY avg_month_spend DESC"
```

Largest transactions this month:

```bash
node cli.js tx list --from YYYY-MM-01 --to YYYY-MM-DD --limit 25
```

Categories without budgets:

```bash
node cli.js query "SELECT DISTINCT category FROM v_tx WHERE amount > 0 AND category NOT IN (SELECT category FROM budgets) ORDER BY category"
```
