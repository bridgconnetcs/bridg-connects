// ══════════════════════════════════════
// BRIDG CONNECTS — TRACKING CONTROL
// Kerry: Edit this file to manage active deliveries
// ══════════════════════════════════════

const DELIVERIES = {
  // Format:
  // "BC-XXXX": { active: true/false, url: "OnFleet link", eta: "2:30 PM", eta_es: "2:30 PM", status: "In Transit", status_es: "En Tránsito" }

  "BC-0001": {
    active: false,
    url: "https://onf.lt/your-link-here",
    eta: "—",
    eta_es: "—",
    status: "In Transit",
    status_es: "En Tránsito"
  }

  // To add a new delivery, copy the block above and change BC-0001 to the next number
  // Give the client their code (e.g. BC-0002) via email or text
  // Set active: true when the delivery starts
  // Set active: false when delivered
};
