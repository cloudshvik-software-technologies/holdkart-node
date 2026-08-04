// Validates a UPI ID against the actual set of PSP/bank handles issued in
// India, not just generic "name@word" syntax. The old regex
// (/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/) matched anything shaped like an email
// local-part — including handles that don't exist (e.g. "name@jyg") — so a
// customer could submit a COD refund payout to an ID that can never
// actually receive money, and it would only surface as a failure much
// later when someone tries to actually pay it out.
//
// This list covers the PSP handles used by the major UPI apps/banks
// (PhonePe, Google Pay, Paytm, Amazon Pay, all major public/private banks).
// It isn't exhaustive of every bank in India, but it covers the handles
// that make up the overwhelming majority of real UPI IDs. Update this list
// if a legitimate handle is rejected.
export const KNOWN_UPI_HANDLES = new Set([
  // PhonePe
  'ybl', 'ibl', 'axl', 'waaxis', 'waicici', 'wahdfcbank', 'wasbi',
  // Google Pay
  'okhdfcbank', 'okicici', 'oksbi', 'okaxis', 'okbizaxis',
  // Paytm
  'paytm', 'ptaxis', 'ptsbi', 'pthdfc', 'pyzee',
  // Amazon Pay
  'apl', 'yapl',
  // BHIM / NPCI
  'upi', 'yapi',
  // Public sector banks
  'sbi', 'pnb', 'cnrb', 'barodampay', 'unionbankofindia', 'unionbank',
  'centralbank', 'idbi', 'boi', 'ucobank', 'iob', 'psib', 'mahb',
  // Private banks
  'icici', 'hdfcbank', 'axisbank', 'kotak', 'yesbank', 'idfcbank',
  'indus', 'induslnd', 'federal', 'fbl', 'rbl', 'dbs', 'kvb', 'karb',
  'jkb', 'sib', 'tjsb', 'dcb', 'csb', 'bandhan',
  // Other fintech / small finance banks
  'jio', 'jiopay', 'airtel', 'fam', 'slice', 'freecharge', 'cub',
  'equitas', 'ujjivan', 'au', 'esaf', 'utkarsh', 'jupiteraxis',
]);

/**
 * Returns true only if `value` is shaped like a UPI ID (local-part@handle)
 * AND the handle is one of the known real PSP/bank handles.
 */
export const isValidUpiId = (value) => {
  const upiId = String(value || '').trim();
  const match = /^[\w.\-]{2,256}@([a-zA-Z]{2,64})$/.exec(upiId);
  if (!match) return false;
  return KNOWN_UPI_HANDLES.has(match[1].toLowerCase());
};