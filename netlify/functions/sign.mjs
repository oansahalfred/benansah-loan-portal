// Benansah Loan Manager — electronic signing of loan agreements.
// The customer (or guarantor) signs by reading back a 6-digit code sent by SMS
// to their own phone. Codes are made and checked here on the server and
// stored only as a scrambled value in a place staff cannot read, so no staff
// member can see or invent a code. A correct code records the signature on the
// loan together with the exact loan terms that were signed.
//
// Uses the same Netlify settings as the reminders: GONLINE_API_KEY,
// GONLINE_SENDER_ID, FIREBASE_API_KEY, ALLOWED_EMAILS, REMINDER_EMAIL,
// REMINDER_PASSWORD.
import crypto from "node:crypto";
import { robotToken, listCollection, writeAudit, sendSms, normalizePhone, decFields } from "./reminders.mjs";

const PROJECT = process.env.FIREBASE_PROJECT_ID || "benansah-fs";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CODE_MINUTES = 10, MAX_TRIES = 5, RESEND_SECONDS = 45;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {"content-type": "application/json"}});
const str = s => ({stringValue: String(s == null ? "" : s)});
const enc = v => v === null || v === undefined ? {nullValue: null}
  : typeof v === "string" ? str(v)
  : typeof v === "boolean" ? {booleanValue: v}
  : typeof v === "number" ? (Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v})
  : {mapValue: {fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]))}};
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const money = n => (Number(n) || 0).toLocaleString("en-GH", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const mask = p => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 9 ? d.slice(0, 3) + "****" + d.slice(-3) : ""; };

// Must match signTerms() in index.html.
function signTerms(loan) {
  const num = v => String(Math.round((Number(v) || 0) * 10000) / 10000);
  const fee = loan.processingFeePct === undefined || loan.processingFeePct === null || loan.processingFeePct === "" ? 0.02 : loan.processingFeePct;
  return {borrowerName: String(loan.borrowerName || "").trim(), borrowerPhone: String(loan.borrowerPhone || "").replace(/\D/g, ""),
    guarantorName: String(loan.guarantorName || "").trim(), guarantorPhone: String(loan.guarantorPhone || "").replace(/\D/g, ""),
    principal: num(loan.principal), interestRatePct: num(loan.interestRatePct), loanTermMonths: num(loan.loanTermMonths),
    processingFeePct: num(fee)};
}

async function getDoc(path, token) {
  const r = await fetch(`${FS}/${path}`, {headers: {authorization: "Bearer " + token}});
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Could not read ${path.split("/")[0]} (${r.status})`);
  const j = await r.json();
  return decFields(j.fields || {});
}
async function patchDoc(path, fields, token, mask) {
  const q = (mask || Object.keys(fields)).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const r = await fetch(`${FS}/${path}?${q}`, {method: "PATCH", headers: {authorization: "Bearer " + token, "content-type": "application/json"},
    body: JSON.stringify({fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)]))})});
  if (!r.ok) throw new Error(`Could not save (${r.status})`);
}
async function deleteDoc(path, token) { await fetch(`${FS}/${path}`, {method: "DELETE", headers: {authorization: "Bearer " + token}}).catch(() => {}); }

// Who is asking, and may they handle applications?
async function caller(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return {error: "Not signed in.", status: 401};
  const look = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(process.env.FIREBASE_API_KEY || "")}`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({idToken: token})
  }).catch(() => null);
  const lj = look ? await look.json().catch(() => ({})) : {};
  const u = look && look.ok && lj.users && lj.users[0];
  const email = (u && u.email || "").toLowerCase();
  if (!email) return {error: "Your sign-in has expired — sign out and sign in again.", status: 401};
  const owners = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (owners.includes(email)) return {email, token, name: "Owner"};
  if (!u.emailVerified) return {error: `${email} is not allowed to do this.`, status: 403};
  const staff = await getDoc(`staff/${encodeURIComponent(email)}`, token).catch(() => null);
  if (!staff) return {error: `${email} is not allowed to do this.`, status: 403};
  const perms = staff.perms || {payments: true, applications: true, extensions: true, sms: true};
  if (!perms.applications) return {error: "Your role does not allow handling loan applications.", status: 403};
  return {email, token, name: staff.name || email};
}

export default async (req) => {
  if (req.method !== "POST") return json({ok: false, error: "Use POST"}, 405);
  let body = {};
  try { body = await req.json(); } catch { return json({ok: false, error: "Bad request."}, 400); }
  const who = await caller(req);
  if (who.error) return json({ok: false, error: who.error}, who.status);
  const refNo = String(body.refNo || ""), role = body.who === "guarantor" ? "guarantor" : "borrower";
  if (!/^[A-Za-z0-9-]{3,40}$/.test(refNo)) return json({ok: false, error: "Unknown loan."}, 400);
  try {
    const robot = await robotToken();
    const loan = await getDoc(`loans/${encodeURIComponent(refNo)}`, robot);
    if (!loan) return json({ok: false, error: "Loan not found."}, 404);
    if (loan.stage !== "pending") return json({ok: false, error: "Only applications that have not been paid out can be signed."}, 400);
    if (loan.hold) return json({ok: false, error: "This application is on hold — remove the hold first."}, 400);
    const name = role === "guarantor" ? loan.guarantorName : loan.borrowerName;
    const to = normalizePhone(role === "guarantor" ? loan.guarantorPhone : loan.borrowerPhone);
    if (!to) return json({ok: false, error: `No valid ${role} phone number on this loan — add it with Edit first.`}, 400);
    const terms = signTerms(loan);
    const otpPath = `otp/${encodeURIComponent(refNo + "_" + role)}`;
    const now = Date.now();

    if (body.action === "send") {
      const old = await getDoc(otpPath, robot);
      if (old && old.sentAt && now - Date.parse(old.sentAt) < RESEND_SECONDS * 1000) {
        return json({ok: false, error: `A code was just sent — wait ${RESEND_SECONDS} seconds before sending another.`}, 429);
      }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const salt = crypto.randomBytes(12).toString("hex");
      const term = Number(loan.loanTermMonths) || 1;
      const total = (Number(loan.principal) || 0) * (1 + (Number(loan.interestRatePct) || 0));
      const msg = role === "guarantor"
        ? `Benansah Financial Solutions: ${code} is your code to GUARANTEE the loan of ${loan.borrowerName} (Ref ${refNo}, total to repay GHS ${money(total)}). Give this code to our staff only if you agree to be guarantor. Valid ${CODE_MINUTES} min.`
        : `Benansah Financial Solutions: ${code} is your code to SIGN loan agreement Ref ${refNo}: GHS ${money(loan.principal)} over ${term} month${term === 1 ? "" : "s"}, total to repay GHS ${money(total)}. Give this code to our staff only if you agree. Valid ${CODE_MINUTES} min.`;
      await patchDoc(otpPath, {hash: sha(salt + "|" + code), salt, expires: new Date(now + CODE_MINUTES * 60000).toISOString(),
        tries: 0, phone: to, termsJson: JSON.stringify(terms), sentAt: new Date(now).toISOString(), sentBy: who.email}, robot);
      const sms = await sendSms(to, msg);
      if (!sms.ok) { await deleteDoc(otpPath, robot); return json({ok: false, error: "The SMS could not be sent: " + (sms.error || "try again")}, 502); }
      return json({ok: true, to: mask(to), minutes: CODE_MINUTES});
    }

    if (body.action === "verify") {
      const code = String(body.code || "").replace(/\D/g, "");
      const otp = await getDoc(otpPath, robot);
      if (!otp) return json({ok: false, error: "No code is waiting — click Send code first."}, 400);
      if (Date.parse(otp.expires) < now) { await deleteDoc(otpPath, robot); return json({ok: false, error: "The code has expired — send a new one."}, 400); }
      if ((otp.tries || 0) >= MAX_TRIES) { await deleteDoc(otpPath, robot); return json({ok: false, error: "Too many wrong codes — send a new one."}, 400); }
      if (otp.termsJson !== JSON.stringify(terms) || otp.phone !== to) {
        await deleteDoc(otpPath, robot);
        return json({ok: false, error: "The loan details changed after the code was sent — send a new code."}, 400);
      }
      const good = code.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(otp.salt + "|" + code)), Buffer.from(otp.hash));
      if (!good) {
        await patchDoc(otpPath, {tries: (otp.tries || 0) + 1}, robot);
        const left = MAX_TRIES - (otp.tries || 0) - 1;
        return json({ok: false, error: left > 0 ? `Wrong code — ${left} tr${left === 1 ? "y" : "ies"} left.` : "Wrong code — send a new one."}, 400);
      }
      const at = new Date().toISOString();
      const id = "SIG-" + crypto.randomBytes(5).toString("hex").toUpperCase();
      const rec = {at, phone: to, name: String(name || ""), by: who.name + " (" + who.email + ")", method: "SMS one-time code", id,
        agreement: "BFS-LA v2 (October 2026)", terms};
      // Only sign.<role> is written; the rest of the loan is untouched.
      const r = await fetch(`${FS}/loans/${encodeURIComponent(refNo)}?updateMask.fieldPaths=sign.${role}`, {
        method: "PATCH", headers: {authorization: "Bearer " + robot, "content-type": "application/json"},
        body: JSON.stringify({fields: {sign: {mapValue: {fields: {[role]: enc(rec)}}}}})});
      if (!r.ok) throw new Error(`Could not save the signature (${r.status})`);
      await deleteDoc(otpPath, robot);
      const audit = await listCollection("auditLog", robot).catch(() => []);
      await writeAudit(robot, audit, [{timestamp: at, action: "Agreement Signed",
        description: `${refNo} — ${role} ${name || ""} signed with the SMS code sent to ${to} (${id}); terms: GHS ${money(loan.principal)}, ${loan.loanTermMonths} mo`,
        performedBy: who.name}]);
      return json({ok: true, id});
    }
    return json({ok: false, error: "Unknown action."}, 400);
  } catch (e) {
    return json({ok: false, error: e.message || "Something went wrong."}, 500);
  }
};
