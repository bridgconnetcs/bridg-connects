/* ══════════════════════════════════════════════════════════════
   BRIDG CONNECTS · Client document delivery
   Reads docs/{email}/ from Firebase Storage and paints the
   Invoices and Documents panels that already exist in the portal.

   WHERE THIS GOES: inside the existing <script type="module"> block
   in portal.html, right after  const db = getFirestore(app);
   ══════════════════════════════════════════════════════════════ */

import { getStorage, ref as sRef, listAll, getDownloadURL, getMetadata }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const storage = getStorage(app);

/* Filenames arrive from Storage rather than from a form, but they are
   still untrusted input: escaped before they touch innerHTML. */
const escDoc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* Strict allowlist. Only our own naming pattern, only PDFs.
   Anything else in the folder is ignored rather than rendered. */
const DOC_NAME = /^BC-(INV|BOL)-[A-Za-z0-9._-]{1,40}\.pdf$/;

const fmtSize = b => b < 1048576
  ? Math.max(1, Math.round(b / 1024)) + ' KB'
  : (b / 1048576).toFixed(1) + ' MB';

async function readClientFolder(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.includes('/')) return [];

  const res = await listAll(sRef(storage, 'docs/' + clean));

  const files = await Promise.all(
    res.items
      .filter(item => DOC_NAME.test(item.name))
      .map(async item => {
        const [url, meta] = await Promise.all([
          getDownloadURL(item),
          getMetadata(item)
        ]);
        return {
          name: item.name.replace(/\.pdf$/i, ''),
          url,
          size: Number(meta.size) || 0,
          at: meta.updated || meta.timeCreated || null
        };
      })
  );

  return files.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
}

function docRow(d) {
  const when = d.at ? new Date(d.at).toLocaleDateString() : '—';
  return '<a class="doc-row" href="' + escDoc(d.url) + '"'
    + ' target="_blank" rel="noopener noreferrer">'
    + '<span class="doc-id"><code>' + escDoc(d.name) + '</code>'
    + '<span class="sub-mono">' + escDoc(when) + ' · ' + fmtSize(d.size) + '</span></span>'
    + '<span class="doc-dl">PDF</span></a>';
}

function paintDocs(mountId, list, emptyLine) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  mount.innerHTML = list.length
    ? list.map(docRow).join('')
    : '<div class="empty"><p>' + escDoc(emptyLine) + '</p></div>';
}

/* Called once a real session resolves. Demo mode never touches this. */
window.loadClientDocs = async (email) => {
  const es = document.body.classList.contains('es');
  try {
    const all = await readClientFolder(email);
    paintDocs('invMount', all.filter(d => d.name.startsWith('BC-INV')),
      es ? 'Aún sin facturas. Aparecen aquí al completar un viaje.'
         : 'No invoices yet. Billing appears here once a run is completed.');
    paintDocs('podMount', all.filter(d => d.name.startsWith('BC-BOL')),
      es ? 'Aún sin conocimientos de embarque.'
         : 'No bills of lading yet.');
  } catch (e) {
    const line = es
      ? 'No se pudieron cargar los documentos. Vuelve a entrar o agenda una llamada.'
      : 'Documents could not be loaded. Sign in again or book a call.';
    paintDocs('invMount', [], line);
    paintDocs('podMount', [], line);
    console.warn('doc load failed:', e && e.code);
  }
};
