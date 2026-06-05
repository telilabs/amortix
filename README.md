# Amortix

Multi-rate mortgage amortization calculator with extra payments.

**[Open app →](https://amortix.pages.dev)**

## Features

- Variable rate schedule — model fixed, tracker, and remortgage scenarios in one loan
- Extra payments — recurring per-period, annual lump sum, and one-off payments
- Two extra-payment modes: reduce term or reduce monthly payment
- Savings summary comparing against the no-extras baseline
- Charts: remaining balance, cumulative principal vs interest, annual breakdown
- Full amortization schedule with CSV export
- Shareable URL — all inputs encoded in the query string
- 18 currencies, multiple payment frequencies (monthly, biweekly, accelerated biweekly, weekly)

## Stack

Static site — plain HTML, CSS, and JavaScript. No build step. [Chart.js](https://www.chartjs.org/) for charts (CDN).
