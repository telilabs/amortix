// ══════════════════════════════════════════════════════════════
//  SECTION 1 — CALCULATION FUNCTIONS  (pure; no DOM access)
// ══════════════════════════════════════════════════════════════
//
// Assumptions
//  Rate compounding  APR ÷ ppy (simple nominal rate, US convention).
//                    Not semi-annual compounding (Canadian standard).
//  Biweekly          26 payments/yr; each period = 14 calendar days.
//  Accel. biweekly   Half a monthly payment paid 26×/yr, giving the
//                    equivalent of 13 monthly payments per year.
//  Rate change       Payment re-amortises at the start of each new
//                    rate segment using current balance + remaining term.
//  Reduce-term       Scheduled payment stays fixed; extras shorten loan.
//  Reduce-payment    After each extra, the scheduled payment is recalc'd
//                    so the loan still ends on the original date.
//  Annual lump sum   Applied at period = round(year × ppy).
//  First payment     1st of the calendar month following today.
//

/**
 * Payment frequency configuration.
 *   ppy   Periods per year
 *   days  Calendar days per period (null for monthly — months vary in length)
 *   label Human-readable name
 */
const FREQUENCY = {
  monthly:                { ppy: 12, days: null, label: 'Monthly' },
  biweekly:               { ppy: 26, days: 14,   label: 'Biweekly' },
  'accelerated-biweekly': { ppy: 26, days: 14,   label: 'Accel. Biweekly' },
  weekly:                 { ppy: 52, days: 7,     label: 'Weekly' },
};

// UI hint text and label fragments — co-located with FREQUENCY so they
// stay in sync. Used in the frequency-change handler and URL decode.
const FREQ_HINTS = {
  monthly:                '',
  biweekly:               '26 payments/yr — one every 2 weeks',
  'accelerated-biweekly': 'Half a monthly payment every 2 weeks — pays off early',
  weekly:                 '52 payments/yr — one every week',
};
const FREQ_PERIOD_NAMES = {
  monthly:                'monthly',
  biweekly:               'biweekly',
  'accelerated-biweekly': 'biweekly',
  weekly:                 'weekly',
};

function periodicRate(annualPct, freq) {
  return annualPct / 100 / FREQUENCY[freq].ppy;
}

function calcPeriodPayment(balance, annualPct, numPeriods, freq) {
  if (numPeriods <= 0) return balance;
  const r = periodicRate(annualPct, freq);
  if (r === 0) return balance / numPeriods;
  const factor = Math.pow(1 + r, numPeriods);
  return balance * (r * factor) / (factor - 1);
}

function normalizeRatePeriods(periods, termYears, ppy) {
  const total = Math.round(termYears * ppy);
  const segs  = [];
  let used    = 0;
  for (let i = 0; i < periods.length; i++) {
    if (used >= total) break;
    const isLast = i === periods.length - 1;
    const count  = isLast
      ? total - used
      : Math.min(Math.round(periods[i].years * ppy), total - used);
    if (count > 0) { segs.push({ periods: count, rate: periods[i].rate }); used += count; }
  }
  return segs;
}

function scheduledPayment(balance, annualPct, periodsLeft, freq) {
  const ppy = FREQUENCY[freq].ppy;
  if (freq === 'accelerated-biweekly') {
    const mLeft = Math.max(1, Math.round((periodsLeft / ppy) * 12));
    return calcPeriodPayment(balance, annualPct, mLeft, 'monthly') / 2;
  }
  return calcPeriodPayment(balance, annualPct, periodsLeft, freq);
}

function buildAmortizationSchedule(principal, ratePeriods, termYears, freq, extras = null) {
  const ppy          = FREQUENCY[freq].ppy;
  const totalPeriods = Math.round(termYears * ppy);
  const isAccel      = freq === 'accelerated-biweekly';
  const isReducePmt  = extras?.mode === 'reduce-payment';
  const segs         = normalizeRatePeriods(ratePeriods, termYears, ppy);

  const extraMap = new Map();
  if (extras?.annual > 0) {
    for (let y = 1; y <= termYears; y++) {
      const p = Math.round(y * ppy);
      if (p >= 1 && p <= totalPeriods)
        extraMap.set(p, (extraMap.get(p) || 0) + extras.annual);
    }
  }
  for (const lump of (extras?.oneOff ?? [])) {
    if (lump.amount > 0 && lump.month >= 1) {
      const p = Math.max(1, Math.round(lump.month * ppy / 12));
      if (p <= totalPeriods)
        extraMap.set(p, (extraMap.get(p) || 0) + lump.amount);
    }
  }

  let balance    = principal;
  const schedule = [];

  for (let si = 0; si < segs.length; si++) {
    if (balance <= 0) break;
    const seg      = segs[si];
    const r        = periodicRate(seg.rate, freq);
    const fixedPmt = scheduledPayment(balance, seg.rate, totalPeriods - schedule.length, freq);

    for (let p = 0; p < seg.periods; p++) {
      if (balance <= 0) break;
      const periodNumber = schedule.length + 1;
      const periodsLeft  = totalPeriods - schedule.length;
      const pmt          = isReducePmt
        ? scheduledPayment(balance, seg.rate, periodsLeft, freq)
        : fixedPmt;

      const lumpExtra     = extraMap.get(periodNumber) || 0;
      const totalExtra    = (extras?.perPeriod ?? 0) + lumpExtra;
      const interest      = balance * r;
      const isLastPeriod  = !isAccel && periodsLeft <= 1;
      const schedPrinc    = isLastPeriod ? balance : Math.min(balance, Math.max(0, pmt - interest));
      const balAfterSched = balance - schedPrinc;
      const extraApplied  = Math.min(balAfterSched, totalExtra);
      balance = Math.max(0, balAfterSched - extraApplied);

      schedule.push({
        periodNumber,
        payment:     interest + schedPrinc,
        extra:       extraApplied,
        interest,
        principal:   schedPrinc + extraApplied,
        balance,
        rate:        seg.rate,
        rateChanged: p === 0 && si > 0,
      });
    }
  }
  return schedule;
}

function calcSummary(schedule, principal, firstPaymentDate, freq) {
  const totalPaid     = schedule.reduce((s, r) => s + r.payment + (r.extra || 0), 0);
  const totalInterest = totalPaid - principal;
  const interestPct   = totalPaid > 0 ? (totalInterest / totalPaid) * 100 : 0;
  const payoffDate    = calcPaymentDate(firstPaymentDate, schedule.length - 1, freq);
  return { totalPaid, totalInterest, interestPct, payoffDate, termPeriods: schedule.length };
}

function calcPaymentDate(firstPaymentDate, n, freq) {
  const d = new Date(firstPaymentDate);
  if (freq === 'monthly') d.setMonth(d.getMonth() + n);
  else                    d.setDate(d.getDate() + n * FREQUENCY[freq].days);
  return d;
}

function fmtDuration(periods, freq) {
  const totalMonths = Math.round(periods / FREQUENCY[freq].ppy * 12);
  const yrs = Math.floor(totalMonths / 12);
  const mos = totalMonths % 12;
  if (yrs === 0) return `${mos} month${mos !== 1 ? 's' : ''}`;
  if (mos === 0) return `${yrs} year${yrs !== 1 ? 's' : ''}`;
  return `${yrs} yr${yrs !== 1 ? 's' : ''} ${mos} mo`;
}

function principalFromPropertyDeposit(price, deposit) { return Math.max(0, price - deposit); }
function ltvPercent(loan, price) { return price ? (loan / price) * 100 : 0; }

// ══════════════════════════════════════════════════════════════
//  SECTION 2 — FORMATTING HELPERS
// ══════════════════════════════════════════════════════════════

let currentCurrency = 'USD';
let currentLocale   = 'en-US';

function fmt(amount, compact = false) {
  const noDecimals = currentCurrency === 'JPY' || currentCurrency === 'KRW';
  try {
    return new Intl.NumberFormat(currentLocale, {
      style: 'currency', currency: currentCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: noDecimals ? 0 : 2,
      ...(compact ? { notation: 'compact', compactDisplay: 'short' } : {}),
    }).format(amount);
  } catch {
    return `${currentCurrency} ${amount.toFixed(2)}`;
  }
}

function fmtMonthYear(d) {
  return d.toLocaleDateString(currentLocale, { month: 'long', year: 'numeric' });
}

function fmtPeriodLabel(d, freq) {
  if (freq === 'monthly')
    return d.toLocaleDateString(currentLocale, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(currentLocale, { month: 'short', day: 'numeric', year: '2-digit' });
}

// ══════════════════════════════════════════════════════════════
//  SECTION 3 — DOM HELPERS
// ══════════════════════════════════════════════════════════════

const $    = id => document.getElementById(id);
const show = el => { el.style.display = ''; };
const hide = el => { el.style.display = 'none'; };

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function hideResults() {
  hide($('resultsSection'));
  hide($('savingsSection'));
  hide($('chartsSection'));
  hide($('tableSection'));
}

// ══════════════════════════════════════════════════════════════
//  SECTION 4 — APPLICATION STATE
// ══════════════════════════════════════════════════════════════

let frequency    = 'monthly';
let ratePeriods  = [{ id: 0, rate: 5.5, years: 25 }];
let nextRpId     = 1;

let extraPerPeriod = 0;
let annualLumpSum  = 0;
let oneOffLumps    = [];
let nextLumpId     = 0;
let extraMode      = 'reduce-term';
let tableCollapsed = false;

// Stored for CSV export
let currentSchedule         = null;
let currentFirstPaymentDate = null;

// Chart instances
let chartBalance    = null;
let chartCumulative = null;
let chartBreakdown  = null;

// ══════════════════════════════════════════════════════════════
//  SECTION 5 — RENDER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function hasAnyExtras() {
  return extraPerPeriod > 0
    || annualLumpSum > 0
    || oneOffLumps.some(l => l.amount > 0 && l.month >= 1);
}

// ─── Rate periods ──────────────────────────

function renderRatePeriodsUI() {
  const termYears = parseFloat($('term').value) || 0;
  const isSingle  = ratePeriods.length === 1;

  $('ratePeriodsContainer').innerHTML = ratePeriods.map((rp, i) => {
    const displayYears = isSingle ? termYears : rp.years;
    return `<div class="rp-row" data-id="${rp.id}">
      <span class="rp-label">Period ${i + 1}</span>
      <div class="rp-field">
        <input type="number" class="rp-rate" inputmode="decimal" value="${rp.rate}" min="0" max="30" step="0.01"
               aria-label="Interest rate for period ${i + 1} in percent" />
        <span class="rp-unit">%</span>
      </div>
      <div class="rp-field">
        <input type="number" class="rp-years" inputmode="decimal" value="${displayYears}"
               min="0.25" max="50" step="0.25" ${isSingle ? 'disabled' : ''}
               aria-label="Duration of period ${i + 1} in years" />
        <span class="rp-unit">yrs</span>
      </div>
      <button class="rp-remove" data-id="${rp.id}" ${isSingle ? 'disabled' : ''} title="Remove">×</button>
    </div>`;
  }).join('');

  $('ratePeriodsContainer').querySelectorAll('.rp-rate').forEach(el  => el.addEventListener('input', onRpChange));
  $('ratePeriodsContainer').querySelectorAll('.rp-years').forEach(el => el.addEventListener('input', onRpChange));
  $('ratePeriodsContainer').querySelectorAll('.rp-remove').forEach(el => el.addEventListener('click', onRpRemove));

  updateRatePeriodsFooter();
}

function updateRatePeriodsFooter() {
  const termYears = parseFloat($('term').value) || 0;
  const isSingle  = ratePeriods.length === 1;
  const el        = $('rpTotal');

  if (isSingle) {
    const yrsInput = $('ratePeriodsContainer').querySelector('.rp-years');
    if (yrsInput) yrsInput.value = termYears;
    el.textContent = termYears ? `${termYears} yr${termYears !== 1 ? 's' : ''} — single fixed rate` : '—';
    el.className   = 'rp-total ok';
    return;
  }

  const totalRpYears = ratePeriods.reduce((s, rp) => s + (parseFloat(rp.years) || 0), 0);
  const diff         = +(termYears - totalRpYears).toFixed(4);

  if (Math.abs(diff) < 0.01) {
    el.textContent = `${totalRpYears} yrs — matches loan term ✓`;
    el.className   = 'rp-total ok';
  } else if (diff > 0) {
    el.textContent = `${totalRpYears} of ${termYears} yrs — last period auto-extends ${diff.toFixed(2)} yrs`;
    el.className   = 'rp-total warn';
  } else {
    el.textContent = `${totalRpYears} yrs total — ${Math.abs(diff).toFixed(2)} yrs excess ignored`;
    el.className   = 'rp-total warn';
  }
}

// ─── One-off lump sums ─────────────────────

function renderOneOffLumpsUI() {
  const container = $('oneOffContainer');
  if (oneOffLumps.length === 0) {
    container.innerHTML = '';
    show($('oneOffEmpty'));
    return;
  }
  hide($('oneOffEmpty'));
  container.innerHTML = oneOffLumps.map(l => `
    <div class="lump-row" data-id="${l.id}">
      <div class="lump-amount-wrap">
        <input type="number" class="lump-amount" inputmode="decimal" value="${l.amount}" min="0" step="100"
               placeholder="Amount" aria-label="Lump sum amount" />
      </div>
      <span class="lump-sep">at month</span>
      <div class="lump-month-wrap">
        <input type="number" class="lump-month" inputmode="numeric" value="${l.month}" min="1" step="1"
               placeholder="12" aria-label="Month number for lump sum" />
      </div>
      <button class="rp-remove lump-remove" data-id="${l.id}" title="Remove">×</button>
    </div>`).join('');

  container.querySelectorAll('.lump-amount').forEach(el => el.addEventListener('input', onLumpChange));
  container.querySelectorAll('.lump-month').forEach(el  => el.addEventListener('input', onLumpChange));
  container.querySelectorAll('.lump-remove').forEach(el => el.addEventListener('click', onLumpRemove));
}

// ─── Summary cards ─────────────────────────

function renderSummaryCards(schedule, summary, termYears) {
  const cfg          = FREQUENCY[frequency];
  const initialPmt   = schedule.length > 0 ? schedule[0].payment : 0;
  const hasMultiRate = ratePeriods.length > 1;
  const hasExtras    = hasAnyExtras();
  const isReducePmt  = extraMode === 'reduce-payment';
  const actualYears  = +(summary.termPeriods / cfg.ppy).toFixed(1);

  $('sPaymentLabel').textContent = `${cfg.label} Payment`;
  $('sMonthly').textContent      = fmt(initialPmt);
  $('sPaymentSub').textContent   =
    hasExtras && isReducePmt ? 'initial scheduled — decreases with extras'
    : hasMultiRate           ? 'initial — resets at each rate change'
    :                          `fixed ${cfg.label.toLowerCase()} payment`;

  $('sTotal').textContent       = fmt(summary.totalPaid);
  $('sTerm').textContent        = actualYears;
  $('sInterest').textContent    = fmt(summary.totalInterest);
  $('sInterestPct').textContent = `${summary.interestPct.toFixed(1)}% of total repaid`;
  $('sPayoff').textContent      = fmtMonthYear(summary.payoffDate);
  $('sPayoffSub').textContent   = `after ${summary.termPeriods} ${cfg.label.toLowerCase()} payments`;

  show($('resultsSection'));
}

// ─── Savings section ───────────────────────

function renderSavingsSection(extrasSchedule, baselineSchedule) {
  if (!hasAnyExtras()) { hide($('savingsSection')); return; }

  const baseInterest   = baselineSchedule.reduce((s, r) => s + r.interest, 0);
  const extrasInterest = extrasSchedule.reduce((s, r) => s + r.interest, 0);
  const interestSaved  = Math.max(0, baseInterest - extrasInterest);
  const savedPct       = baseInterest > 0 ? (interestSaved / baseInterest) * 100 : 0;
  const periodsSaved   = baselineSchedule.length - extrasSchedule.length;

  $('savInterest').textContent    = fmt(interestSaved);
  $('savInterestPct').textContent = `${savedPct.toFixed(1)}% less interest`;

  if (periodsSaved > 0) {
    $('savTime').textContent    = fmtDuration(periodsSaved, frequency);
    $('savTimeSub').textContent = `${periodsSaved} fewer ${FREQUENCY[frequency].label.toLowerCase()} payments`;
  } else {
    $('savTime').textContent    = '—';
    $('savTimeSub').textContent = 'same payoff date';
  }
  show($('savingsSection'));
}

// ─── Charts ─────────────────────────────────

/**
 * Group schedule rows by calendar year. Returns one entry per year with:
 *   label, balance (last of year), cumPrincipal, cumInterest, yrPrincipal, yrInterest
 */
function buildYearlyData(schedule, firstPaymentDate) {
  const yearMap    = new Map();
  let cumPrincipal = 0;
  let cumInterest  = 0;

  for (const row of schedule) {
    const date = calcPaymentDate(firstPaymentDate, row.periodNumber - 1, frequency);
    const yr   = date.getFullYear();
    cumPrincipal += row.principal;
    cumInterest  += row.interest;

    if (!yearMap.has(yr)) {
      yearMap.set(yr, { label: String(yr), balance: 0, cumPrincipal: 0, cumInterest: 0, yrPrincipal: 0, yrInterest: 0 });
    }
    const y = yearMap.get(yr);
    y.balance      = row.balance;
    y.cumPrincipal = cumPrincipal;
    y.cumInterest  = cumInterest;
    y.yrPrincipal += row.principal;
    y.yrInterest  += row.interest;
  }
  return [...yearMap.values()];
}

function renderBalanceChart(sharedOpts, baseLabels, balBaseline, balExtras, showExtras) {
  if (!chartBalance) {
    chartBalance = new Chart($('chartBalanceCanvas'), {
      type: 'line',
      data: {
        labels: baseLabels,
        datasets: [
          {
            label: 'Scheduled',
            data:  balBaseline,
            borderColor:     '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.07)',
            fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2,
          },
          {
            label: 'With Extras',
            data:  balExtras,
            borderColor:     '#10b981',
            backgroundColor: 'rgba(16,185,129,0.09)',
            fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2,
            hidden: !showExtras,
          }
        ]
      },
      options: {
        ...sharedOpts,
        plugins: {
          ...sharedOpts.plugins,
          legend: {
            display:  showExtras,
            position: 'top', align: 'end',
            labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, padding: 12 }
          }
        }
      }
    });
  } else {
    chartBalance.data.labels              = baseLabels;
    chartBalance.data.datasets[0].data   = balBaseline;
    chartBalance.data.datasets[1].data   = balExtras;
    chartBalance.data.datasets[1].hidden = !showExtras;
    chartBalance.options.plugins.legend.display = showExtras;
    chartBalance.update('none');
  }
}

function renderCumulativeChart(sharedOpts, legendOpts, cumulLabels, cumPrinc, cumInt) {
  if (!chartCumulative) {
    chartCumulative = new Chart($('chartCumulativeCanvas'), {
      type: 'line',
      data: {
        labels: cumulLabels,
        datasets: [
          {
            label: 'Principal',
            data:  cumPrinc,
            borderColor:     '#10b981',
            backgroundColor: 'rgba(16,185,129,0.12)',
            fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2,
          },
          {
            label: 'Interest',
            data:  cumInt,
            borderColor:     '#f87171',
            backgroundColor: 'rgba(248,113,113,0.12)',
            fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2,
          }
        ]
      },
      options: {
        ...sharedOpts,
        plugins: {
          ...sharedOpts.plugins,
          legend:  legendOpts,
          tooltip: { mode: 'index', callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } }
        }
      }
    });
  } else {
    chartCumulative.data.labels            = cumulLabels;
    chartCumulative.data.datasets[0].data = cumPrinc;
    chartCumulative.data.datasets[1].data = cumInt;
    chartCumulative.update('none');
  }
}

function renderBreakdownChart(sharedOpts, legendOpts, yrLabels, yrPrinc, yrInt) {
  if (!chartBreakdown) {
    chartBreakdown = new Chart($('chartBreakdownCanvas'), {
      type: 'bar',
      data: {
        labels: yrLabels,
        datasets: [
          {
            label:           'Principal',
            data:            yrPrinc,
            backgroundColor: 'rgba(16,185,129,0.72)',
            stack:           'p',
          },
          {
            label:           'Interest',
            data:            yrInt,
            backgroundColor: 'rgba(248,113,113,0.72)',
            stack:           'p',
          }
        ]
      },
      options: {
        ...sharedOpts,
        plugins: {
          ...sharedOpts.plugins,
          legend:  legendOpts,
          tooltip: { mode: 'index', callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 15, font: { size: 10 } } },
          y: { stacked: true, ticks: { callback: v => fmt(v, true), maxTicksLimit: 5, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.04)' } }
        }
      }
    });
  } else {
    chartBreakdown.data.labels            = yrLabels;
    chartBreakdown.data.datasets[0].data = yrPrinc;
    chartBreakdown.data.datasets[1].data = yrInt;
    chartBreakdown.update('none');
  }
}

function renderCharts(baselineSchedule, extrasSchedule) {
  if (typeof Chart === 'undefined') {
    show($('chartsSection'));
    const cs = $('chartsSection');
    if (!cs.dataset.chartFail) {
      cs.querySelector('.charts-grid').innerHTML =
        '<p style="color:var(--gray-400);font-size:0.85rem;padding:1rem 0">' +
        'Charts unavailable — Chart.js CDN failed to load.</p>';
      cs.dataset.chartFail = '1';
    }
    return;
  }

  show($('chartsSection'));

  const firstPayment = currentFirstPaymentDate;
  const showExtras   = hasAnyExtras();
  const baseData     = buildYearlyData(baselineSchedule, firstPayment);
  const activeData   = showExtras ? buildYearlyData(extrasSchedule, firstPayment) : baseData;

  const firstRow    = baselineSchedule[0];
  const principal0  = firstRow ? firstRow.balance + firstRow.principal : 0;
  const baseLabels  = ['Start', ...baseData.map(d => d.label)];
  const balBaseline = [principal0, ...baseData.map(d => d.balance)];
  const extrasBalMap = new Map(activeData.map(d => [d.label, d.balance]));
  const balExtras   = [principal0, ...baseData.map(d => extrasBalMap.get(d.label) ?? 0)];

  const cumulLabels = ['Start', ...activeData.map(d => d.label)];
  const cumPrinc    = [0, ...activeData.map(d => d.cumPrincipal)];
  const cumInt      = [0, ...activeData.map(d => d.cumInterest)];

  const yrLabels = activeData.map(d => d.label);
  const yrPrinc  = activeData.map(d => d.yrPrincipal);
  const yrInt    = activeData.map(d => d.yrInterest);

  const sharedOpts = {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    plugins: {
      tooltip: {
        callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` }
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
      y: { ticks: { callback: v => fmt(v, true), maxTicksLimit: 5, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.04)' } }
    }
  };
  const legendOpts = {
    display: true, position: 'top', align: 'end',
    labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, padding: 12 }
  };

  renderBalanceChart(sharedOpts, baseLabels, balBaseline, balExtras, showExtras);
  renderCumulativeChart(sharedOpts, legendOpts, cumulLabels, cumPrinc, cumInt);
  renderBreakdownChart(sharedOpts, legendOpts, yrLabels, yrPrinc, yrInt);
}

// ─── Amortization table ────────────────────

function renderAmortizationTable(schedule) {
  const showExtra = hasAnyExtras();
  $('scheduleTable').classList.toggle('has-extras', showExtra);

  const rows    = [];
  let   lastYear = -1;

  for (const row of schedule) {
    const date    = calcPaymentDate(currentFirstPaymentDate, row.periodNumber - 1, frequency);
    const year    = date.getFullYear();
    const newYear = year !== lastYear;
    lastYear      = year;

    if (row.rateChanged) {
      rows.push(`<tr class="rate-divider"><td colspan="6">Rate changes to ${row.rate.toFixed(2)}%</td></tr>`);
    }

    const rowClass  = (!row.rateChanged && newYear) ? 'year-row' : '';
    const extraCell = row.extra > 0 ? fmt(row.extra) : '—';

    rows.push(`<tr class="${rowClass}">
      <td>${fmtPeriodLabel(date, frequency)}</td>
      <td>${fmt(row.payment)}</td>
      <td class="td-extra">${extraCell}</td>
      <td class="td-interest">${fmt(row.interest)}</td>
      <td class="td-principal">${fmt(row.principal)}</td>
      <td class="td-balance">${fmt(row.balance)}</td>
    </tr>`);
  }

  $('scheduleBody').innerHTML = rows.join('');
  show($('tableSection'));
}

function renderError(msg) {
  const el = $('errorMsg');
  el.textContent = msg; el.style.display = 'block';
  hideResults();
}

function clearError() {
  const el = $('errorMsg');
  el.textContent = ''; el.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
//  SECTION 5b — URL STATE  (encode all inputs; decode on load)
// ══════════════════════════════════════════════════════════════

function encodeURL() {
  try {
    const params = new URLSearchParams();
    params.set('price',   $('price').value   || '');
    params.set('deposit', $('deposit').value || '');
    params.set('term', $('term').value || '');
    params.set('freq', frequency);
    params.set('curr', `${currentCurrency}|${currentLocale}`);
    params.set('rp',   JSON.stringify(ratePeriods.map(p => ({ r: p.rate, y: p.years }))));
    params.set('epp',  String(extraPerPeriod));
    params.set('als',  String(annualLumpSum));
    params.set('em',   extraMode);
    if (oneOffLumps.length > 0)
      params.set('oo', JSON.stringify(oneOffLumps.map(l => ({ a: l.amount, m: l.month }))));
    history.replaceState(null, '', '?' + params.toString());
  } catch {}
}

function decodeURL() {
  const params = new URLSearchParams(location.search);
  if (!params.size) return;

  // Only accept finite numbers within valid ranges to prevent malformed input.
  const setNum = (id, raw, min, max) => {
    const v = parseFloat(raw);
    if (isFinite(v) && v >= min && v <= max) $(id).value = String(v);
  };
  setNum('price',   params.get('price'),   0, 1e9);
  setNum('deposit', params.get('deposit'), 0, 1e9);
  setNum('term',    params.get('term'),    1, 50);

  // Frequency
  const freq = params.get('freq');
  if (freq && FREQUENCY[freq]) {
    frequency = freq;
    $('frequency').value = freq;
    $('labelExtraPer').textContent = `Extra per ${FREQ_PERIOD_NAMES[freq]} payment`;
    $('freqHint').textContent = FREQ_HINTS[freq] || '';
  }

  // Currency — only accept a value that matches an existing <option>.
  const curr = params.get('curr');
  if (curr) {
    const opt = Array.from($('currencySelect').options).find(o => o.value === curr);
    if (opt) {
      [currentCurrency, currentLocale] = curr.split('|');
      $('currencySelect').value = curr;
    }
  }

  // Rate periods — clamp values; cap array length to prevent DoS.
  try {
    const rp = JSON.parse(params.get('rp') || '[]');
    if (Array.isArray(rp) && rp.length > 0 && rp.length <= 20) {
      ratePeriods = rp.map((p, i) => ({
        id:    i,
        rate:  Math.min(30, Math.max(0, parseFloat(p.r) || 0)),
        years: Math.min(50, Math.max(0, parseFloat(p.y) || 0)),
      }));
      nextRpId = ratePeriods.length;
    }
  } catch {}

  // Extra payments
  const epp = Math.max(0, parseFloat(params.get('epp')) || 0);
  extraPerPeriod = isFinite(epp) ? epp : 0;
  $('extraPerPeriod').value = String(extraPerPeriod || 0);

  const als = Math.max(0, parseFloat(params.get('als')) || 0);
  annualLumpSum = isFinite(als) ? als : 0;
  $('annualLumpSum').value = String(annualLumpSum || 0);

  // Extra mode
  const em = params.get('em');
  if (em === 'reduce-term' || em === 'reduce-payment') {
    extraMode = em;
    document.querySelectorAll('#extraModeToggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.emode === em);
    });
  }

  // One-off lumps — cap array length to prevent DoS.
  try {
    const oo = JSON.parse(params.get('oo') || '[]');
    if (Array.isArray(oo) && oo.length > 0 && oo.length <= 120) {
      oneOffLumps = oo.map((l, i) => ({
        id:     i,
        amount: Math.max(0, parseFloat(l.a) || 0),
        month:  Math.max(1, parseInt(l.m, 10) || 1),
      }));
      nextLumpId = oneOffLumps.length;
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  SECTION 5c — CSV EXPORT
// ══════════════════════════════════════════════════════════════

function exportCSV() {
  if (!currentSchedule || currentSchedule.length === 0) return;

  const extras  = hasAnyExtras();
  const headers = extras
    ? ['Date', 'Payment', 'Extra', 'Interest', 'Principal', 'Balance']
    : ['Date', 'Payment', 'Interest', 'Principal', 'Balance'];

  const lines = [headers.join(',')];

  for (const r of currentSchedule) {
    const date = calcPaymentDate(currentFirstPaymentDate, r.periodNumber - 1, frequency);
    const iso  = date.toISOString().split('T')[0];
    const vals = extras
      ? [iso, r.payment.toFixed(2), (r.extra || 0).toFixed(2), r.interest.toFixed(2), r.principal.toFixed(2), r.balance.toFixed(2)]
      : [iso, r.payment.toFixed(2), r.interest.toFixed(2), r.principal.toFixed(2), r.balance.toFixed(2)];
    lines.push(vals.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'mortgage-schedule.csv' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════
//  SECTION 6 — RECALCULATION ORCHESTRATOR
// ══════════════════════════════════════════════════════════════

function recalculate() {
  clearError();
  encodeURL();

  const term    = parseFloat($('term').value);
  const price   = parseFloat($('price').value) || 0;
  const deposit = parseFloat($('deposit').value) || 0;
  const principal = principalFromPropertyDeposit(price, deposit);

  $('derivedLoan').textContent = price > 0 ? fmt(principal) : '—';
  $('hintDeposit').textContent = price > 0 ? `${((deposit / price) * 100).toFixed(1)}% of property price` : '';
  $('hintLTV').textContent     = price > 0 ? `LTV: ${ltvPercent(principal, price).toFixed(1)}%` : '';

  if (price > 0 && deposit >= price) { renderError('Deposit must be less than the property price.'); return; }
  if (!price) { hideResults(); return; }

  if (isNaN(term) || term < 1 || term > 50) { renderError('Term must be between 1 and 50 years.'); return; }
  for (const rp of ratePeriods) {
    if (isNaN(rp.rate) || rp.rate < 0 || rp.rate > 30) { renderError('Each rate must be between 0% and 30%.'); return; }
    if (ratePeriods.length > 1 && (!rp.years || rp.years <= 0)) { renderError('Each rate period must have a duration > 0.'); return; }
  }

  // First payment = 1st day of next month
  const firstPayment = new Date();
  firstPayment.setDate(1);
  firstPayment.setMonth(firstPayment.getMonth() + 1);
  currentFirstPaymentDate = firstPayment;

  const extras = { perPeriod: extraPerPeriod, annual: annualLumpSum, oneOff: oneOffLumps, mode: extraMode };

  const baselineSchedule = buildAmortizationSchedule(principal, ratePeriods, term, frequency);
  const extrasSchedule   = hasAnyExtras()
    ? buildAmortizationSchedule(principal, ratePeriods, term, frequency, extras)
    : baselineSchedule;

  if (extrasSchedule.length === 0) { renderError('Unable to build a schedule with these inputs.'); return; }

  currentSchedule = extrasSchedule;

  const summary = calcSummary(extrasSchedule, principal, firstPayment, frequency);

  renderSummaryCards(extrasSchedule, summary, term);
  renderSavingsSection(extrasSchedule, baselineSchedule);
  renderCharts(baselineSchedule, extrasSchedule);
  renderAmortizationTable(extrasSchedule);
}

// ══════════════════════════════════════════════════════════════
//  SECTION 7 — EVENT HANDLERS
// ══════════════════════════════════════════════════════════════

const debouncedRecalc = debounce(recalculate, 120);

// ─── Header ────────────────────────────────

$('copyLinkBtn').addEventListener('click', () => {
  const btn = $('copyLinkBtn');
  navigator.clipboard.writeText(location.href).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Link'; }, 2200);
  }).catch(() => {
    prompt('Copy this URL:', location.href);
  });
});

// ─── Loan details ──────────────────────────

$('frequency').addEventListener('change', e => {
  frequency = e.target.value;
  $('freqHint').textContent = FREQ_HINTS[frequency] || '';
  $('labelExtraPer').textContent = `Extra per ${FREQ_PERIOD_NAMES[frequency]} payment`;
  recalculate();
});

['price', 'deposit'].forEach(id => $(id).addEventListener('input', debouncedRecalc));
$('term').addEventListener('input', () => { updateRatePeriodsFooter(); debouncedRecalc(); });
$('currencySelect').addEventListener('change', e => {
  [currentCurrency, currentLocale] = e.target.value.split('|');
  recalculate();
});

// ─── Rate periods ──────────────────────────

function onRpChange(e) {
  const row = e.target.closest('.rp-row');
  const id  = parseInt(row.dataset.id, 10);
  const rp  = ratePeriods.find(r => r.id === id);
  if (!rp) return;
  if (e.target.classList.contains('rp-rate')) rp.rate  = parseFloat(e.target.value) || 0;
  else                                         rp.years = parseFloat(e.target.value) || 0;
  updateRatePeriodsFooter();
  debouncedRecalc();
}

function onRpRemove(e) {
  const id = parseInt(e.currentTarget.dataset.id, 10);
  if (ratePeriods.length <= 1) return;
  ratePeriods = ratePeriods.filter(rp => rp.id !== id);
  renderRatePeriodsUI();
  recalculate();
}

$('addPeriod').addEventListener('click', () => {
  const termYears = parseFloat($('term').value) || 25;
  const lastRate  = ratePeriods.at(-1)?.rate ?? 5.5;
  if (ratePeriods.length === 1) {
    const half = +(termYears / 2).toFixed(1);
    ratePeriods[0].years = half;
    ratePeriods.push({ id: nextRpId++, rate: lastRate, years: +(termYears - half).toFixed(1) });
  } else {
    const usedYears = ratePeriods.reduce((s, rp) => s + (parseFloat(rp.years) || 0), 0);
    ratePeriods.push({ id: nextRpId++, rate: lastRate, years: Math.max(0.25, +(termYears - usedYears).toFixed(2)) });
  }
  renderRatePeriodsUI();
  recalculate();
});

// ─── Extra payments ────────────────────────

$('extraModeToggle').addEventListener('click', e => {
  const btn = e.target.closest('[data-emode]');
  if (!btn) return;
  extraMode = btn.dataset.emode;
  document.querySelectorAll('#extraModeToggle .toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
  recalculate();
});

$('extraPerPeriod').addEventListener('input', e => {
  extraPerPeriod = Math.max(0, parseFloat(e.target.value) || 0);
  debouncedRecalc();
});

$('annualLumpSum').addEventListener('input', e => {
  annualLumpSum = Math.max(0, parseFloat(e.target.value) || 0);
  debouncedRecalc();
});

function onLumpChange(e) {
  const row  = e.target.closest('.lump-row');
  const id   = parseInt(row.dataset.id, 10);
  const lump = oneOffLumps.find(l => l.id === id);
  if (!lump) return;
  if (e.target.classList.contains('lump-amount')) lump.amount = Math.max(0, parseFloat(e.target.value) || 0);
  else                                             lump.month  = Math.max(1, parseInt(e.target.value, 10) || 1);
  debouncedRecalc();
}

function onLumpRemove(e) {
  const id = parseInt(e.currentTarget.dataset.id, 10);
  oneOffLumps = oneOffLumps.filter(l => l.id !== id);
  renderOneOffLumpsUI();
  recalculate();
}

$('addLump').addEventListener('click', () => {
  const term      = parseFloat($('term').value) || 25;
  const lastMonth = oneOffLumps.length > 0 ? oneOffLumps.at(-1).month + 12 : 12;
  const month     = Math.min(lastMonth, Math.floor(term * 12));
  oneOffLumps.push({ id: nextLumpId++, amount: 1000, month });
  renderOneOffLumpsUI();
  recalculate();
});

// ─── Table actions ─────────────────────────

$('exportCsvBtn').addEventListener('click', exportCSV);

$('toggleTableBtn').addEventListener('click', () => {
  tableCollapsed = !tableCollapsed;
  $('tableCollapsible').classList.toggle('is-collapsed', tableCollapsed);
  $('toggleTableBtn').textContent = tableCollapsed ? 'Show' : 'Hide';
});

// ══════════════════════════════════════════════════════════════
//  SECTION 8 — BOOT
// ══════════════════════════════════════════════════════════════

decodeURL();
renderRatePeriodsUI();
renderOneOffLumpsUI();
recalculate();
