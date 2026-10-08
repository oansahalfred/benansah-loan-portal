// Benansah Loan Manager — automatic SMS reminders (G Online).
// Runs every morning (see daily-reminders.mjs) and from the app's
// "Preview" / "Send now" buttons on the SMS tab.
//
// The loan rules and message wording in the middle of this file are copied
// from index.html, so reminders always use exactly the figures shown in the app.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   GONLINE_API_KEY, GONLINE_SENDER_ID, FIREBASE_API_KEY, ALLOWED_EMAILS  (already set for Send)
//   REMINDER_EMAIL, REMINDER_PASSWORD  the reminder account created in Firebase Authentication

const PROJECT = process.env.FIREBASE_PROJECT_ID || "benansah-fs";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const GONLINE = "https://sms.gonlinesites.com/app/sms/api";
const GONLINE_HTTP = "http://sms.gonlinesites.com/app/sms/api";
const DEDUPE_DAYS = 20;       // the same message is never sent twice to a loan within this many days
const AUDIT_BUCKET_CAP = 500; // must match index.html

// ======================= Copied from index.html =======================
const RATE_CARD = { 1: 0.20, 2: 0.36, 3: 0.48, 4: 0.64, 5: 0.80, 6: 0.96 };

const MAX_TERM = 6;

const SMS_TEMPLATES = [
  {id:"0A", title:"Application Received", text:"Dear [Customer Name], we have received your application for GHS [Amount] (Ref [Ref No.]). We will confirm by SMS once it has been reviewed. Benansah Financial Solutions. Tel 0543717151."},
  {id:"0B", title:"Application Confirmed", text:"Dear [Customer Name], your application for GHS [Amount] (Ref [Ref No.]) has been confirmed. The funds will be sent to you shortly. Benansah Financial Solutions. Tel 0543717151."},
  {id:"0C", title:"Application Not Approved", text:"Dear [Customer Name], thank you for your application (Ref [Ref No.]). We are unable to approve it at this time. You are welcome to apply again in future. Benansah Financial Solutions. Tel 0543717151."},
  {id:"0D", title:"Application On Hold", text:"Dear [Customer Name], your application for GHS [Amount] (Ref [Ref No.]) is on hold as we need some more information from you. Please call 0543717151 or visit our office. Benansah Financial Solutions."},
  {id:"0E", title:"Still Waiting for Information (Day 7)", text:"Dear [Customer Name], we are still waiting for some information to complete your application for GHS [Amount] (Ref [Ref No.]). Please call 0543717151 or visit our office. Benansah Financial Solutions."},
  {id:"1A", title:"Funds Sent (Mobile Wallet)", text:"Dear [Customer Name], GHS [Net Amount] has been sent to your mobile wallet [MoMo Number] for Ref [Ref No.] (GHS [Amount] less GHS [Fee] processing fee). First payment of GHS [Installment] is due on [First Due Date]. We will never ask for your PIN. Benansah Financial Solutions."},
  {id:"1B", title:"Funds Paid (Cash)", text:"Dear [Customer Name], GHS [Net Amount] has been paid to you in person for Ref [Ref No.] (GHS [Amount] less GHS [Fee] processing fee). First payment of GHS [Installment] is due on [First Due Date]. We will never ask for your PIN. Benansah Financial Solutions."},
  {id:"1C", title:"Top-Up Completed", text:"Dear [Customer Name], your top-up Ref [Ref No.] is complete. GHS [Settled Amount] cleared your balance on Ref [Old Ref No.] and GHS [Net Amount] has been paid to you. First payment of GHS [Installment] is due on [First Due Date]. We will never ask for your PIN. Benansah Financial Solutions."},
  {id:"1D", title:"Funds Sent (Bank / Other)", text:"Dear [Customer Name], GHS [Net Amount] has been sent to you for Ref [Ref No.] (GHS [Amount] less GHS [Fee] processing fee). First payment of GHS [Installment] is due on [First Due Date]. We will never ask for your PIN. Benansah Financial Solutions."},
  {id:"2A", title:"Repayment Plan (1 Month)", text:"Dear [Customer Name], your repayment for Ref [Ref No.] is GHS [Total Repayment], due on [Final Due Date]. Pay to 0243642425 (Owusu-Ansah Alfred) quoting Ref [Ref No.]. Benansah Financial Solutions. Tel 0543717151."},
  {id:"2B", title:"Repayment Plan (Multi-Month)", text:"Dear [Customer Name], your repayment plan for Ref [Ref No.] is [Term] monthly payments of GHS [Installment], due on the [Day] of each month from [First Due Date] to [Final Due Date]. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"3A", title:"3-Day Reminder (1 Month)", text:"Dear [Customer Name], a friendly reminder that your payment of GHS [Amount] for Ref [Ref No.] is due on [Date]. Please pay to 0243642425 (Owusu-Ansah Alfred). Thank you. Benansah Financial Solutions."},
  {id:"3B", title:"3-Day Reminder (Multi-Month)", text:"Dear [Customer Name], a friendly reminder that installment [Installment No.] of GHS [Amount] for Ref [Ref No.] is due on [Date]. Please pay to 0243642425 (Owusu-Ansah Alfred). Thank you. Benansah Financial Solutions."},
  {id:"3C", title:"Payday Reminder (1 Month)", text:"Dear [Customer Name], as payday approaches, please plan your payment of GHS [Amount] for Ref [Ref No.], due on [Date]. Paying on time keeps your record strong. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"3D", title:"Payday Reminder (Multi-Month)", text:"Dear [Customer Name], as payday approaches, please plan installment [Installment No.] of GHS [Amount] for Ref [Ref No.], due on [Date]. Paying on time keeps your record strong. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"4A", title:"Due Today (1 Month)", text:"Dear [Customer Name], your payment of GHS [Amount] for Ref [Ref No.] is due today, [Date]. Please pay to 0243642425 (Owusu-Ansah Alfred) today to avoid a 10% late charge. Benansah Financial Solutions."},
  {id:"4B", title:"Due Today (Multi-Month)", text:"Dear [Customer Name], installment [Installment No.] of GHS [Amount] for Ref [Ref No.] is due today, [Date]. Please pay to 0243642425 (Owusu-Ansah Alfred) today to avoid a 10% late charge. Benansah Financial Solutions."},
  {id:"4C", title:"Payment Missed (1 Month)", text:"Dear [Customer Name], your payment for Ref [Ref No.] due on [Date] has not been paid in full. A 10% late charge of GHS [Penalty Amount] applies. Now due: GHS [New Total Amount]. Pay within 14 days to avoid a further 10%. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"4D", title:"Payment Missed (Multi-Month)", text:"Dear [Customer Name], installment [Installment No.] for Ref [Ref No.] due on [Date] has not been paid in full. A 10% late charge of GHS [Penalty Amount] applies. Now due: GHS [New Total Amount]. Pay within 14 days to avoid a further 10%. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"4E", title:"Second Notice (Day 3)", text:"Dear [Customer Name], we have not yet received GHS [New Total Amount] for Ref [Ref No.] following our notice 2 days ago. Please pay today to 0243642425 (Owusu-Ansah Alfred) to avoid further charges. Tel 0543717151. Benansah Financial Solutions."},
  {id:"4F", title:"Second Late Charge (Day 15)", text:"Dear [Customer Name], Ref [Ref No.] is now 15 days past due and a second 10% late charge has been added. Amount now due: GHS [New Total Amount]. Please pay today to 0243642425 (Owusu-Ansah Alfred). Tel 0543717151. Benansah Financial Solutions."},
  {id:"6A", title:"Guarantor Notice (to Borrower)", text:"Dear [Customer Name], Ref [Ref No.] is 7 days past due with GHS [New Total Amount] outstanding. As stated in your agreement, your guarantor, [Guarantor Name], is being contacted today. Please pay to 0243642425 (Owusu-Ansah Alfred). Tel 0543717151. Benansah Financial Solutions."},
  {id:"6B", title:"Guarantor Notice (to Guarantor)", text:"Dear [Guarantor Name], you are the guarantor for [Customer Name] (Ref [Ref No.]), whose payment of GHS [New Total Amount] is 7 days past due. Kindly help ensure payment to 0243642425 (Owusu-Ansah Alfred). Tel 0543717151. Benansah Financial Solutions."},
  {id:"6C", title:"Extension Granted", text:"Dear [Customer Name], your request for more time on Ref [Ref No.] has been granted. Please pay GHS [New Total Amount] by [Extended Date]. No further late charges will be added until then. Pay to 0243642425 (Owusu-Ansah Alfred). Benansah Financial Solutions."},
  {id:"6E", title:"Extension Date Reminder", text:"Dear [Customer Name], a reminder that your extended payment date for Ref [Ref No.] is [Extended Date]. Amount due: GHS [New Total Amount]. Please pay to 0243642425 (Owusu-Ansah Alfred) on or before this date. Benansah Financial Solutions."},
  {id:"6D", title:"Extension Date Missed", text:"Dear [Customer Name], the extended date of [Extended Date] for Ref [Ref No.] has passed without payment. Late charges have resumed and your guarantor, [Guarantor Name], is being contacted. Please call 0543717151 today. Benansah Financial Solutions."},
  {id:"5A", title:"Payment Received (Fully Settled)", text:"Dear [Customer Name], we have received GHS [Last Payment] for Ref [Ref No.]. Your account is now fully settled. Thank you for paying with us. Benansah Financial Solutions. Tel 0543717151."},
  {id:"5B", title:"Payment Received (Installment)", text:"Dear [Customer Name], we have received GHS [Last Payment] for Ref [Ref No.]. Remaining balance: GHS [Balance]. Your next payment of GHS [Amount] is due on [Date]. Thank you. Benansah Financial Solutions."},
  {id:"5C", title:"Clearance Confirmation", text:"Dear [Customer Name], Ref [Ref No.] is fully settled. Thank you for your excellent payment record. You may apply for a higher amount on your next request. Benansah Financial Solutions. Tel 0543717151."}
];

const DEFAULT_SWAPS = [
  {from: "loan", to: "facility"}, {from: "MoMo", to: "mobile wallet"}, {from: "urgent", to: "important"},
  {from: "penalty", to: "late charge"}, {from: "overdue", to: "past due"}, {from: "approved", to: "confirmed"}
];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtDate(iso) {
  const mt = ISO_RE.exec(String(iso || "").slice(0, 10));
  if (!mt) return "—";
  const d = new Date(Date.UTC(+mt[1], +mt[2] - 1, +mt[3]));
  if (isNaN(d)) return "—";
  return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric', timeZone:'UTC'});
}

function todayISO() {
  const d = new Date(); // the date on the staff member's own calendar
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function addMonths(iso, n) {
  const mt = ISO_RE.exec(String(iso || ""));
  if (!mt) return null;
  const y = +mt[1], m0 = +mt[2] - 1 + n, d = +mt[3];
  const ny = y + Math.floor(m0 / 12);
  const nm = ((m0 % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return ny + "-" + pad2(nm + 1) + "-" + pad2(Math.min(d, lastDay));
}

function daysBetween(fromISO, toISO) {
  const a = ISO_RE.exec(fromISO || ""), b = ISO_RE.exec(toISO || "");
  if (!a || !b) return 0;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}

const LATE_FEE_RATE = 0.10;

const SECOND_CHARGE_DAY = 15;  // days after the due date

const MAX_LATE_CHARGES = 2;

const DEFAULT_FEE_PCT = 0.02;

const ALLOC_RULE_FROM = "2026-10-07";

const HOLD_FOLLOWUP_DAYS = 7;   // one follow-up text (0E) after this many days on hold

const HOLD_EXPIRY_DAYS = 30;    // flagged as expired after this many days on hold

function dayNum(iso) {
  const mt = ISO_RE.exec(String(iso || ""));
  return mt ? Math.round(Date.UTC(+mt[1], +mt[2] - 1, +mt[3]) / 86400000) : NaN;
}

function isoFromDay(n) {
  const d = new Date(n * 86400000);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function loanStage(loan) {
  return loan && (loan.stage === 'pending' || loan.stage === 'declined') ? loan.stage : 'disbursed';
}

function feePctOf(loan) {
  const v = Number(loan.processingFeePct);
  return (loan.processingFeePct === undefined || loan.processingFeePct === null || loan.processingFeePct === "" || isNaN(v)) ? DEFAULT_FEE_PCT : v;
}

function computeLoanMetricsRaw(loan) {
  const stage = loanStage(loan);
  const principal = Number(loan.principal) || 0;
  const term = Math.max(1, parseInt(loan.loanTermMonths, 10) || 1);
  const interestAmount = round2(principal * (Number(loan.interestRatePct) || 0));
  const totalRepayment = round2(principal + interestAmount);
  const monthlyInstallment = round2(totalRepayment / term);
  const feePct = feePctOf(loan);
  const processingFee = round2(principal * feePct);
  const netDisbursed = round2(principal - processingFee);
  const topUpSettlement = round2(Number(loan.topUpSettlement) || 0);
  const cashToCustomer = round2(netDisbursed - topUpSettlement);
  // An application put on hold while waiting for information from the customer.
  const hold = stage === 'pending' && loan.hold && ISO_RE.test(loan.hold.on || "") ? loan.hold : null;
  const holdDays = hold ? Math.max(0, daysBetween(hold.on, todayISO())) : 0;

  // Repayment schedule: one installment per month from the disbursement date.
  const startISO = ISO_RE.test(loan.disbursementDate || "") ? loan.disbursementDate : todayISO();
  const schedule = [];
  let cum = 0;
  for (let k = 1; k <= term; k++) {
    const amount = k < term ? monthlyInstallment : round2(totalRepayment - monthlyInstallment * (term - 1));
    cum = round2(cum + amount);
    const dueDate = addMonths(startISO, k);
    schedule.push({no: k, dueDate, dueDay: dayNum(dueDate), amount, cumulative: cum});
  }
  const firstDueDate = schedule[0].dueDate;
  const finalDueDate = schedule[term - 1].dueDate;

  const startDay = dayNum(startISO);
  const loanPayments = payments.filter(p => p.refNo === loan.refNo)
    .map(p => { const d = dayNum(p.paymentDate); return {amt: Number(p.amountPaid) || 0, day: isNaN(d) ? startDay : d, p}; })
    .sort((a, b) => a.day - b.day);
  const amountPaid = round2(loanPayments.reduce((s, x) => s + x.amt, 0));

  const base = {
    stage, principal, term, interestAmount, totalRepayment, monthlyInstallment, feePct, processingFee,
    netDisbursed, topUpSettlement, cashToCustomer, schedule, firstDueDate, finalDueDate, amountPaid, loanPayments,
    hold, onHold: !!hold, holdDays, holdExpired: !!hold && holdDays >= HOLD_EXPIRY_DAYS
  };

  if (stage !== 'disbursed') {
    return Object.assign(base, {
      charges: [], lateFee: 0, lateFeePaid: 0, lateFeeOutstanding: 0, overpaid: 0,
      remainingBalance: 0, totalPayableWithPenalty: 0, amountOverdueNow: 0, arrearsAmount: 0,
      nextDueDate: null, nextInstallmentNo: null, amountDueNext: 0,
      isOverdue: false, overdueTier: 0, lateFeePct: 0, daysOverdue: 0, overdueLabel: '',
      daysUntilDue: null, dueSoon: false, dueThisWeek: false, installmentsPaid: 0,
      scheduleRows: schedule.map(s => ({...s, effDueDate: s.dueDate, paidAmt: 0, status: 'Planned'})),
      extension: null, extActive: false, extBreached: false,
      status: stage === 'pending' ? (hold ? 'On Hold' : 'Application Pending') : 'Declined', performanceRating: 'N/A'
    });
  }

  const today = dayNum(todayISO());
  const ext = loan.extension && ISO_RE.test(loan.extension.date || "") ? loan.extension : null;
  const extDay = ext ? dayNum(ext.date) : NaN;
  const grantDay = ext ? (ISO_RE.test(ext.grantedOn || "") ? dayNum(ext.grantedOn) : extDay) : NaN;
  // Once an extension is granted, every installment due up to the new date moves to that date.
  const effDue = (k, d) => (ext && d >= grantDay && schedule[k].dueDay <= extDay) ? extDay : schedule[k].dueDay;
  const firstUnpaid = paidPI => schedule.findIndex(s => paidPI < s.cumulative - 0.005);
  // Payments clear the OLDEST amount owed first (standard "oldest debt first"):
  // an installment, then the late charge added after it, then the next
  // installment. So paying "installment + its late charge" clears both, and
  // the next installment is untouched.
  const ruleDay = dayNum(ALLOC_RULE_FROM);
  const allocate = (paidOld, paidNew, chs, d) => {
    const instPaid = schedule.map(() => 0), chPaid = chs.map(() => 0);
    // Payments before the change: installments in order, then late charges.
    let left = paidOld;
    schedule.forEach((s, i) => { const t = Math.max(Math.min(left, s.amount), 0); instPaid[i] = t; left -= t; });
    chs.forEach((c, j) => { const t = Math.max(Math.min(left, c.amount), 0); chPaid[j] = t; left -= t; });
    // Payments since the change: oldest amount still owed first.
    left = Math.max(left, 0) + paidNew;
    const items = schedule.map((s, i) => ({inst: true, idx: i, day: effDue(i, d), amt: s.amount}))
      .concat(chs.map((c, j) => ({inst: false, idx: j, day: dayNum(c.date), amt: c.amount})))
      .sort((a, b) => a.day - b.day || (a.inst === b.inst ? a.idx - b.idx : (a.inst ? 1 : -1)));
    for (const it of items) {
      if (left <= 0.005) break;
      const arr = it.inst ? instPaid : chPaid;
      const take = Math.min(left, it.amt - arr[it.idx]);
      if (take <= 0) continue;
      arr[it.idx] += take;
      left -= take;
    }
    return {instPaid, chPaid, left: Math.max(round2(left), 0)};
  };

  // Walk day by day from the first due date to today, adding late charges
  // per installment (see the rule above).
  const charges = [];
  const charged = schedule.map(() => 0);           // charges added so far, per installment
  let pi = 0, paidOld = 0, paidNew = 0;
  const addPay = x => { if (x.day < ruleDay) paidOld += x.amt; else paidNew += x.amt; };
  const loopStart = schedule[0].dueDay + 1;
  while (pi < loanPayments.length && loanPayments[pi].day < loopStart) addPay(loanPayments[pi++]);
  for (let d = loopStart; d <= today; d++) {
    while (pi < loanPayments.length && loanPayments[pi].day <= d) addPay(loanPayments[pi++]);
    if (ext && d >= grantDay && d <= extDay) {     // charges paused during an extension;
      schedule.forEach((s, i) => { if (s.dueDay <= extDay) charged[i] = 0; });   // missed new date = start again
      continue;
    }
    const al = allocate(paidOld, paidNew, charges, d);   // what each installment has received so far
    for (let i = 0; i < term; i++) {
      const due = effDue(i, d);
      if (d <= due) break;                           // later installments are not due yet
      const unpaid = round2(Math.max(schedule[i].amount - al.instPaid[i], 0));
      if (unpaid <= 0.005) continue;
      const tier = Math.min(MAX_LATE_CHARGES, (d - due) >= SECOND_CHARGE_DAY ? 2 : 1);
      while (charged[i] < tier) {
        charged[i]++;
        charges.push({date: isoFromDay(d), amount: round2(unpaid * LATE_FEE_RATE), base: unpaid, tier: charged[i], installmentNo: i + 1});
      }
    }
  }

  const lateFee = round2(charges.reduce((s, c) => s + c.amount, 0));
  const fin = allocate(round2(loanPayments.filter(x => x.day < ruleDay).reduce((t, x) => t + x.amt, 0)),
    round2(loanPayments.filter(x => x.day >= ruleDay).reduce((t, x) => t + x.amt, 0)), charges, today);
  charges.forEach((c, j) => { c.paid = round2(fin.chPaid[j]); });
  const paidPI = round2(fin.instPaid.reduce((s, x) => s + x, 0));
  const lateFeePaid = round2(fin.chPaid.reduce((s, x) => s + x, 0));
  const overpaid = fin.left;
  const remainingBalance = round2(Math.max(totalRepayment - paidPI, 0));
  const lateFeeOutstanding = round2(Math.max(lateFee - lateFeePaid, 0));
  const totalPayableWithPenalty = round2(remainingBalance + lateFeeOutstanding);

  let deferredCumAll = 0;
  if (ext) schedule.forEach(s => { if (s.dueDay <= extDay) deferredCumAll = s.cumulative; });
  // An extension only matters while something it covers is still unpaid.
  const extActive = !!ext && today <= extDay && totalPayableWithPenalty > 0.005 && (deferredCumAll - paidPI > 0.005 || lateFeeOutstanding > 0.005);
  const extBreached = !!ext && today > extDay && totalPayableWithPenalty > 0.005;

  // The oldest installment still unpaid after its due date sets the overdue status.
  const kLate = firstUnpaid(paidPI);
  const lateStart = kLate >= 0 ? effDue(kLate, today) : NaN;
  const piOverdue = kLate >= 0 && today >= loopStart && today > lateStart && !(ext && today >= grantDay && today <= extDay);
  const episode = piOverdue ? {startDay: lateStart, tier: Math.max(1, charged[kLate])} : null;
  // Only late charges left after the last installment: shown as overdue. A late
  // charge still unpaid earlier in the loan is added to the next amount due
  // (it is cleared first), and does not by itself make the loan overdue.
  const feesOnlyOverdue = !piOverdue && !extActive && remainingBalance <= 0.005 && lateFeeOutstanding > 0.005;
  const oldestUnpaidCharge = charges.find(c => c.amount - c.paid > 0.005);
  const isOverdue = piOverdue || feesOnlyOverdue;
  const overdueTier = piOverdue ? episode.tier : 0;
  const lateFeePct = overdueTier * LATE_FEE_RATE;
  const lastDue = effDue(term - 1, today);
  const daysOverdue = piOverdue ? today - episode.startDay
    : (feesOnlyOverdue ? Math.max(1, today - (oldestUnpaidCharge ? dayNum(oldestUnpaidCharge.date) : lastDue)) : 0);
  const overdueLabel = piOverdue
    ? `${(lateFeePct * 100).toFixed(0)}% late charges — ${today - episode.startDay} day${today - episode.startDay === 1 ? '' : 's'} late${overdueTier < MAX_LATE_CHARGES ? ` · another 10% on ${fmtDate(isoFromDay(episode.startDay + SECOND_CHARGE_DAY))} if unpaid` : ' · maximum reached'}`
    : (feesOnlyOverdue ? 'Late charges still unpaid' : '');

  // Amount that is past due right now (installments whose date has passed).
  let cumDuePast = 0;
  schedule.forEach((s, i) => { if (effDue(i, today) < today) cumDuePast = s.cumulative; });
  const arrearsAmount = round2(Math.max(cumDuePast - paidPI, 0));
  const amountOverdueNow = isOverdue ? round2(arrearsAmount + lateFeeOutstanding) : 0;

  // Next payment: the earliest installment not yet fully paid.
  const kNext = firstUnpaid(paidPI);
  let nextDueDate = null, nextInstallmentNo = null, amountDueNext = 0;
  if (extActive) {
    nextDueDate = ext.date;
    nextInstallmentNo = kNext >= 0 ? kNext + 1 : null;
    let deferredCum = 0;
    schedule.forEach(s => { if (s.dueDay <= extDay) deferredCum = s.cumulative; });
    amountDueNext = round2(Math.max(deferredCum - paidPI, 0) + lateFeeOutstanding);
  } else if (kNext >= 0) {
    const nd = effDue(kNext, today);
    nextDueDate = isoFromDay(nd);
    nextInstallmentNo = kNext + 1;
    let cumThrough = 0;
    schedule.forEach((s, i) => { if (effDue(i, today) <= nd) cumThrough = s.cumulative; });
    amountDueNext = round2(Math.max(cumThrough - paidPI, 0) + lateFeeOutstanding);   // unpaid late charges are cleared first
  } else if (lateFeeOutstanding > 0.005) {
    amountDueNext = lateFeeOutstanding;
  }

  const daysUntilDue = (!isOverdue && nextDueDate) ? Math.max(dayNum(nextDueDate) - today, 0) : null;
  const dueSoon = daysUntilDue !== null && daysUntilDue <= 3;
  const dueThisWeek = daysUntilDue !== null && daysUntilDue <= 7;
  const installmentsPaid = schedule.filter(s => paidPI >= s.cumulative - 0.005).length;

  const scheduleRows = schedule.map((s, i) => {
    const prev = i ? schedule[i - 1].cumulative : 0;
    const paidAmt = round2(Math.min(Math.max(paidPI - prev, 0), s.amount));
    const eff = effDue(i, today);
    let st;
    if (paidAmt >= s.amount - 0.005) st = 'Paid';
    else if (eff < today) st = 'Past due';
    else if (eff === today) st = 'Due today';
    else if (paidAmt > 0) st = 'Part paid';
    else st = 'Upcoming';
    return {...s, effDueDate: isoFromDay(eff), paidAmt, status: st};
  });

  let status;
  if (totalPayableWithPenalty <= 0.005) status = "Fully Paid";
  else if (isOverdue) status = "Overdue";
  else if (extActive) status = "Extended";
  else if (amountPaid > 0) status = "Partially Paid";
  else status = "Pending Payment";

  let performanceRating;
  if (status === "Fully Paid") performanceRating = "Excellent";
  else if (status === "Overdue" || status === "Extended") performanceRating = "High Risk";
  else if (status === "Partially Paid") performanceRating = "Good";
  else performanceRating = "Standard";

  return Object.assign(base, {
    charges, lateFee, lateFeePaid, lateFeeOutstanding, overpaid,
    remainingBalance, totalPayableWithPenalty, amountOverdueNow, arrearsAmount,
    nextDueDate, nextInstallmentNo, amountDueNext,
    isOverdue, overdueTier, lateFeePct, daysOverdue, overdueLabel,
    daysUntilDue, dueSoon, dueThisWeek, installmentsPaid, scheduleRows,
    extension: ext, extActive, extBreached,
    status, performanceRating
  });
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function ordinal(n) {
  n = Number(n);
  if (!n) return "";
  const s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({1: "st", 2: "nd", 3: "rd"}[n % 10] || "th");
  return n + s;
}

function money2(n) { return (Number(n) || 0).toLocaleString('en-GH', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

function smsValues(loan, m, id) {
  const lastPay = m.loanPayments.length ? m.loanPayments[m.loanPayments.length - 1].amt : 0;
  const amount = ['0A', '0B', '0D', '0E', '1A', '1B', '1C', '1D'].includes(id) ? (Number(loan.principal) || 0)
    : (id === '3C' ? m.totalPayableWithPenalty : (m.amountDueNext > 0 ? m.amountDueNext : m.monthlyInstallment));
  const newTotal = m.extActive ? m.amountDueNext : (m.isOverdue ? m.amountOverdueNow : m.totalPayableWithPenalty);
  const nextDate = m.nextDueDate ? fmtDate(m.nextDueDate) : "";
  return {
    "[Customer Name]": loan.borrowerName || "", "[Ref No.]": loan.refNo || "", "[Amount]": money2(amount),
    "[Net Amount]": money2(loan.topUpOf ? m.cashToCustomer : m.netDisbursed), "[Fee]": money2(m.processingFee),
    "[Installment]": money2(m.monthlyInstallment), "[Total Repayment]": money2(m.totalRepayment),
    "[First Due Date]": fmtDate(m.firstDueDate), "[Final Due Date]": fmtDate(m.finalDueDate),
    "[Date]": nextDate, "[Due Date]": nextDate,
    "[Installment No.]": m.nextInstallmentNo ? `${m.nextInstallmentNo} of ${m.term}` : "",
    "[Day]": ordinal(m.firstDueDate.slice(8, 10)), "[Term]": String(m.term),
    "[Balance]": money2(m.totalPayableWithPenalty), "[MoMo Number]": loan.borrowerPhone || "",
    "[Guarantor Name]": loan.guarantorName || "your guarantor", "[Penalty Amount]": money2(m.lateFeeOutstanding),
    "[New Total Amount]": money2(newTotal), "[Extended Date]": m.extension ? fmtDate(m.extension.date) : "",
    "[Last Payment]": money2(lastPay), "[Old Ref No.]": loan.topUpOf || "", "[Settled Amount]": money2(m.topUpSettlement)
  };
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchCase(word, repl) {
  if (word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) return repl.toUpperCase();
  if (word[0] && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}

function applySwaps(text, swaps) {
  return text.split(/(\[[^\]]+\])/).map(part => /^\[[^\]]+\]$/.test(part) ? part :
    (swaps || swapDraft || smsSwaps).reduce((acc, s) => {
      const from = (s.from || "").trim();
      if (!from) return acc;
      const re = new RegExp('(^|[^A-Za-z0-9])(' + escapeRegex(from) + ')(?=[^A-Za-z0-9]|$)', 'gi');
      return acc.replace(re, (all, pre, word) => pre + matchCase(word, s.to || ""));
    }, part)).join('');
}

function smsRecipient(loan, id) {
  const guar = id === '6B';
  return {name: guar ? (loan.guarantorName || 'Guarantor') : loan.borrowerName, phone: (guar ? loan.guarantorPhone : loan.borrowerPhone) || '', guar};
}
// ===================== End of copy from index.html =====================

let payments = [];
let swapDraft = null;
let smsSwaps = DEFAULT_SWAPS.map(x => ({...x}));

// Which message (if any) a loan should get automatically today.
// Recipient "g" = guarantor, otherwise the borrower.
function autoPlan(loan, m, opts) {
  if (!m) return [];
  // Application on hold: one "still waiting for information" text after 7 days.
  if (m.stage === "pending") return (m.onHold && m.holdDays >= HOLD_FOLLOWUP_DAYS && m.holdDays <= HOLD_FOLLOWUP_DAYS + 6) ? ["0E"] : [];
  if (m.stage !== "disbursed" || m.totalPayableWithPenalty <= 0.005) return [];
  const multi = m.term > 1;
  if (m.extActive) return (m.daysUntilDue !== null && m.daysUntilDue <= 2) ? ["6E"] : [];
  if (m.isOverdue) {
    if (m.remainingBalance <= 0.005) return [];          // only late charges left — follow up personally
    const d = m.daysOverdue;
    // Guarantor notices only when a guarantor with a valid phone is on file.
    const hasGuarantor = opts.guarantor && !!(loan.guarantorName || "").trim() && !!normalizePhone(loan.guarantorPhone);
    if (m.extBreached && hasGuarantor && d >= 1 && d <= 3) return ["6D"];
    if (m.overdueTier >= 2 && d >= 15 && d <= 17) return ["4F"];
    if (hasGuarantor && d >= 7 && d <= 13) return ["6A", "6B"];
    if (d >= 3 && d <= 6) return ["4E"];
    if (d >= 1 && d <= 2) return [multi ? "4D" : "4C"];
    return [];
  }
  if (m.daysUntilDue === 0) return [multi ? "4B" : "4A"];
  if (m.daysUntilDue !== null && m.daysUntilDue >= 1 && m.daysUntilDue <= 3) return [multi ? "3B" : "3A"];
  return [];
}

// ---------- Firestore (REST) ----------
function dec(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  return null;
}
export function decFields(f) { const o = {}; for (const k of Object.keys(f || {})) o[k] = dec(f[k]); return o; }
const str = s => ({stringValue: String(s == null ? "" : s)});

export async function listCollection(name, token) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 50; i++) {
    const url = `${FS}/${name}?pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const r = await fetch(url, {headers: {authorization: "Bearer " + token}});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Could not read ${name} (${r.status}${j.error && j.error.status ? " " + j.error.status : ""})`);
    for (const d of j.documents || []) out.push({...decFields(d.fields), _id: decodeURIComponent(d.name.split("/").pop())});
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

// Adds entries to this month's activity record without touching the others.
export async function writeAudit(token, auditDocs, entries) {
  if (!entries.length) return;
  const now = new Date();
  const month = now.getUTCFullYear() + "-" + pad2(now.getUTCMonth() + 1);
  let bucket = month + "_overflow";
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? month : month + "_" + n;
    const doc = auditDocs.find(d => d._id === id);
    if (!doc || Object.keys(doc.entries || {}).length + entries.length <= AUDIT_BUCKET_CAP) { bucket = id; break; }
  }
  const fields = {};
  const mask = ["updateMask.fieldPaths=period"];
  entries.forEach((e, i) => {
    const key = "a" + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 7);
    fields[key] = {mapValue: {fields: {timestamp: str(e.timestamp), action: str(e.action), description: str(e.description), performedBy: str(e.performedBy)}}};
    mask.push("updateMask.fieldPaths=entries." + key);
  });
  const r = await fetch(`${FS}/auditLog/${encodeURIComponent(bucket)}?${mask.join("&")}`, {
    method: "PATCH", headers: {authorization: "Bearer " + token, "content-type": "application/json"},
    body: JSON.stringify({fields: {period: str(bucket), entries: {mapValue: {fields}}}})
  });
  if (!r.ok) console.error("Activity log write failed", r.status, await r.text().catch(() => ""));
}

// ---------- Sign-in ----------
export async function robotToken() {
  const key = process.env.FIREBASE_API_KEY, email = process.env.REMINDER_EMAIL, password = process.env.REMINDER_PASSWORD;
  if (!key || !email || !password) throw new Error("Automatic reminders are not set up yet — add REMINDER_EMAIL and REMINDER_PASSWORD on Netlify.");
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({email, password, returnSecureToken: true})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.idToken) throw new Error("The reminder account could not sign in (" + ((j.error && j.error.message) || r.status) + ").");
  return j.idToken;
}
async function callerEmail(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return {error: "Not signed in.", status: 401};
  const look = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(process.env.FIREBASE_API_KEY || "")}`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({idToken: token})
  }).catch(() => null);
  const lj = look ? await look.json().catch(() => ({})) : {};
  const u = look && look.ok && lj.users && lj.users[0];
  const email = (u && u.email || "").toLowerCase();
  if (!email) return {error: "Your sign-in has expired — sign out and sign in again.", status: 401};
  const allowed = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  let ok = allowed.includes(email);
  if (!ok && u.emailVerified) {   // staff added in the app (Finances → Staff Access)
    const r = await fetch(`${FS}/staff/${encodeURIComponent(email)}`, {headers: {authorization: "Bearer " + token}}).catch(() => null);
    ok = !!(r && r.ok);
  }
  if (!ok) return {error: `${email} is not allowed to send SMS.`, status: 403};
  return {email, token};
}

// ---------- G Online ----------
export function normalizePhone(raw) {
  let p = String(raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("00")) p = p.slice(2);
  if (/^0\d{9}$/.test(p)) p = "233" + p.slice(1);
  return /^233\d{9}$/.test(p) ? p : "";
}
export async function sendSms(to, message) {
  const KEY = process.env.GONLINE_API_KEY, SENDER = process.env.GONLINE_SENDER_ID;
  if (!KEY || !SENDER) return {ok: false, error: "G Online settings missing on Netlify"};
  const q = `action=send-sms&api_key=${encodeURIComponent(KEY)}&to=${encodeURIComponent(to)}&from=${encodeURIComponent(SENDER)}&sms=${encodeURIComponent(message)}`;
  for (const base of [GONLINE, GONLINE_HTTP]) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`${base}?${q}`, {headers: {Accept: "application/json"}, signal: ctl.signal});
      clearTimeout(t);
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      const code = data && data.code !== undefined ? String(data.code).toLowerCase() : "";
      const ok = r.ok && (data ? code === "ok" : true);
      return {ok, error: ok ? undefined : ((data && (data.message || data.msg || data.code)) || "G Online did not accept the message")};
    } catch (e) { /* try the next address */ }
  }
  return {ok: false, error: "Could not reach G Online"};
}

// Remaining SMS credit, as a number when G Online's reply contains one.
const LOW_SMS_CREDIT = 100;
async function smsCredit() {
  const KEY = process.env.GONLINE_API_KEY;
  if (!KEY) return null;
  for (const base of [GONLINE, GONLINE_HTTP]) {
    try {
      const r = await fetch(`${base}?action=check-balance&api_key=${encodeURIComponent(KEY)}`, {headers: {Accept: "application/json"}});
      const text = await r.text();
      let d = null; try { d = JSON.parse(text); } catch { d = null; }
      const v = d && typeof d === "object" ? (d.balance ?? (d.data && (d.data.balance ?? d.data.credit ?? d.data.units)) ?? d.credit ?? d.sms_balance ?? d.message) : text;
      const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
      return isNaN(n) ? null : n;
    } catch (e) { /* try next */ }
  }
  return null;
}

// ---------- The run ----------
// trigger: "schedule" (8 AM daily) | "manual" (Send now) ; dryRun: preview only.
export async function runReminders({token, dryRun, trigger, by}) {
  const [loans, pays, settings, auditDocs] = await Promise.all([
    listCollection("loans", token), listCollection("payments", token),
    listCollection("settings", token), listCollection("auditLog", token)
  ]);
  const auto = settings.find(s => s._id === "autoSms") || {};
  const smsSet = settings.find(s => s._id === "sms");
  if (smsSet && Array.isArray(smsSet.swaps)) smsSwaps = smsSet.swaps.map(x => ({from: x.from || "", to: x.to || ""}));
  if (trigger === "schedule" && !auto.enabled) return {skipped: "Automatic reminders are switched off in the app.", items: []};
  payments = pays;
  const opts = {guarantor: !!auto.guarantor};

  const since = Date.now() - DEDUPE_DAYS * 86400000;
  const sentLog = [];
  for (const d of auditDocs) for (const e of Object.values(d.entries || {})) {
    if (e && e.action === "SMS Sent" && e.timestamp && Date.parse(e.timestamp) >= since) sentLog.push(e.description || "");
  }
  const alreadySent = (id, refNo) => {
    const re = new RegExp(" for " + escapeRegex(refNo) + "(?![0-9A-Za-z])");
    return sentLog.some(desc => desc.startsWith(id + " ") && re.test(desc));
  };

  const items = [];
  for (const loan of loans) {
    if (!loan.refNo) continue;
    const m = computeLoanMetricsRaw(loan);
    for (const id of autoPlan(loan, m, opts)) {
      const t = SMS_TEMPLATES.find(x => x.id === id);
      if (!t) continue;
      const r = smsRecipient(loan, id);
      const vals = smsValues(loan, m, id);
      const text = applySwaps(t.text, smsSwaps).replace(/\[[^\]]+\]/g, ph => vals[ph] !== undefined ? vals[ph] : ph);
      const to = normalizePhone(r.phone);
      const item = {refNo: loan.refNo, borrower: loan.borrowerName || "", name: r.name || "", phone: r.phone || "", to, id, title: t.title, text};
      if (alreadySent(id, loan.refNo)) item.status = "already";
      else if (!to) item.status = "nophone";
      else item.status = "send";
      items.push(item);
    }
  }
  items.sort((a, b) => a.borrower.localeCompare(b.borrower) || a.id.localeCompare(b.id));
  if (dryRun) return {items, enabled: !!auto.enabled};

  const toSend = items.filter(i => i.status === "send");
  for (let i = 0; i < toSend.length; i += 4) {
    await Promise.all(toSend.slice(i, i + 4).map(async it => {
      const res = await sendSms(it.to, it.text);
      it.status = res.ok ? "sent" : "failed";
      if (!res.ok) it.error = res.error;
    }));
  }
  const nowIso = new Date().toISOString();
  const who = trigger === "schedule" ? "Auto reminder" : (by || "Send now");
  const entries = items.filter(i => i.status === "sent").map(it => ({
    timestamp: nowIso, action: "SMS Sent", performedBy: who,
    description: `${it.id} to ${it.name} (${it.to}) for ${it.refNo}${it.name !== it.borrower ? " — guarantor of " + it.borrower : ""}`
  }));
  const sent = items.filter(i => i.status === "sent").length;
  const failed = items.filter(i => i.status === "failed");
  const noPhone = items.filter(i => i.status === "nophone");
  let summary = `${trigger === "schedule" ? "Daily run" : "Sent from app"}: ${sent} sent, ${failed.length} failed`;
  if (noPhone.length) summary += `, ${noPhone.length} skipped (no valid phone: ${noPhone.map(i => i.refNo).join(", ")})`;
  if (failed.length) summary += ` — failed: ${failed.map(i => `${i.id} ${i.refNo} (${i.error})`).join("; ")}`;
  const credit = await smsCredit();
  const low = credit !== null && credit < LOW_SMS_CREDIT;
  if (credit !== null) summary += ` · SMS credit left: ${credit}${low ? " (LOW — top up)" : ""}`;
  entries.push({timestamp: nowIso, action: "Auto Reminders", description: summary, performedBy: who});
  await writeAudit(token, auditDocs, entries);

  const ownerTo = normalizePhone(auto.summaryPhone);
  if (ownerTo && (sent || failed.length || low)) {
    await sendSms(ownerTo, `BFS reminders ${fmtDate(todayISO())}: ${sent} sent, ${failed.length} not delivered.${low ? ` SMS credit is low (${credit} left), please top up G Online.` : ""} Details on the SMS tab. Benansah Financial Solutions.`);
  }
  return {items, summary, sent, failed: failed.length, credit};
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {"content-type": "application/json"}});

// The app's Preview / Send now buttons.
export default async (req) => {
  if (req.method !== "POST") return json({ok: false, error: "Use POST"}, 405);
  const who = await callerEmail(req);
  if (who.error) return json({ok: false, error: who.error}, who.status);
  let body = {};
  try { body = await req.json(); } catch { /* empty body = preview */ }
  try {
    const out = await runReminders({token: who.token, dryRun: body.action !== "run", trigger: "manual", by: who.email});
    return json({ok: true, ...out});
  } catch (e) {
    return json({ok: false, error: e.message || "Something went wrong."}, 500);
  }
};
