const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serves index.html, spaform.html, and spa-skeleton.html (fetched by the handler at runtime)
app.use(express.static(path.join(__dirname)));

// Install / setup screen — Bitrix calls this on app install
app.all('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// The SPA Form tab rendered inside the Deal
app.all('/spaform.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'spaform.html'));
});

// Same-origin proxy for the unit image (cdn.bitrix24.com sends no CORS header,
// so the image can only be embedded into the PDF when fetched via this proxy).
app.get('/image-proxy', (req, res) => {
    const target = req.query.url || '';
    let host;
    try { host = new URL(target).hostname.toLowerCase(); }
    catch (e) { return res.status(400).send('Bad url'); }

    const allowedHosts = ['cdn.bitrix24.com', 'cdn.bitrix24.de', 'cdn.bitrix24.eu'];
    if (!allowedHosts.includes(host)) return res.status(403).send('Host not allowed');

    https.get(encodeURI(target), (upstream) => {
        if (upstream.statusCode && upstream.statusCode >= 400) {
            upstream.resume();
            return res.status(502).send('Upstream HTTP ' + upstream.statusCode);
        }
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        upstream.pipe(res);
    }).on('error', () => res.status(502).send('Fetch failed'));
});

// ── Read a static asset from disk and return it as a data-URI (for header/cover) ──
function fileDataUrl(file, mime) {
    try {
        const buf = fs.readFileSync(path.join(__dirname, file));
        return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch (e) { return ''; }
}

// ── Server-side PDF rendering with headless Chrome ──
// Receives the fully-rendered SPA HTML (CSS + body, unit image already inlined),
// renders it with real Chrome pagination + running header/footer, prepends the
// cover page, and returns the finished PDF as base64.
app.post('/render-pdf', async (req, res) => {
    const { html, spsl } = req.body || {};
    if (!html) return res.status(400).json({ error: 'missing html' });

    const ref   = String(spsl || '').replace(/[<>&"]/g, '');
    const logoL = fileDataUrl('logo-pci.png', 'image/png');
    const logoR = fileDataUrl('logo-southlofts.png', 'image/png');

    let browser;
    try {
        const launchOpts = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };
        // Full puppeteer ships its own Chromium and finds it automatically. Only
        // override the path if an explicit one is provided via the environment.
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });

        const headerTemplate =
            '<div style="width:100%; box-sizing:border-box; padding:4mm 10mm 0; font-family:Arial,sans-serif; -webkit-print-color-adjust:exact;">' +
              '<div style="font-style:italic; font-size:8px; color:#777;">' + ref + '</div>' +
              '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:1.5mm;">' +
                (logoL ? '<img src="' + logoL + '" style="height:9mm;">' : '<span></span>') +
                (logoR ? '<img src="' + logoR + '" style="height:12mm;">' : '<span></span>') +
              '</div>' +
            '</div>';

        const footerTemplate =
            '<div style="width:100%; box-sizing:border-box; padding:0 10mm; font-family:Arial,sans-serif; font-size:9px; display:flex; justify-content:space-between;">' +
              '<span>Page <span class="pageNumber"></span></span>' +
              '<span>Buyer Initials: __________</span>' +
            '</div>';

        const bodyPdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerTemplate,
            footerTemplate: footerTemplate,
            margin: { top: '30mm', bottom: '16mm', left: '10mm', right: '10mm' }
        });
        await browser.close();
        browser = null;

        // Prepend the cover page (full-page image, no header/footer, unnumbered).
        const merged  = await PDFDocument.create();
        try {
            const coverBytes = fs.readFileSync(path.join(__dirname, 'cover.png'));
            const coverImg   = await merged.embedPng(coverBytes);
            const A4W = 595.28, A4H = 841.89; // points
            const cover = merged.addPage([A4W, A4H]);
            cover.drawImage(coverImg, { x: 0, y: 0, width: A4W, height: A4H });
        } catch (e) { /* no cover available — skip */ }

        const bodyDoc = await PDFDocument.load(bodyPdf);
        const pages   = await merged.copyPages(bodyDoc, bodyDoc.getPageIndices());
        pages.forEach(function (p) { merged.addPage(p); });

        const out = await merged.save();
        res.json({ base64: Buffer.from(out).toString('base64') });
    } catch (e) {
        if (browser) { try { await browser.close(); } catch (_) {} }
        console.error('[SPA] render-pdf error:', e);
        res.status(500).send(String(e && e.message ? e.message : e));
    }
});

// ── EN→AR translation proxy ───────────────────────────────────────────────
// Default: free MyMemory API (no key). Upgrade path: set GOOGLE_TRANSLATE_KEY
// (or AZURE_TRANSLATE_KEY + AZURE_TRANSLATE_REGION) as env vars — no code change.
const TRANSLATE_CACHE = {};   // en -> ar, persists for the server's lifetime

function httpsJson(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (r) => {
            let data = '';
            r.on('data', (c) => data += c);
            r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function translateOne(text) {
    if (process.env.GOOGLE_TRANSLATE_KEY) {
        const body = JSON.stringify({ q: text, source: 'en', target: 'ar', format: 'text' });
        const j = await httpsJson({
            method: 'POST', hostname: 'translation.googleapis.com',
            path: '/language/translate/v2?key=' + process.env.GOOGLE_TRANSLATE_KEY,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, body);
        return (j && j.data && j.data.translations && j.data.translations[0]
                && j.data.translations[0].translatedText) || '';
    }
    if (process.env.AZURE_TRANSLATE_KEY) {
        const body = JSON.stringify([{ Text: text }]);
        const j = await httpsJson({
            method: 'POST', hostname: 'api.cognitive.microsofttranslator.com',
            path: '/translate?api-version=3.0&from=en&to=ar',
            headers: {
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATE_KEY,
                'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATE_REGION || 'global'
            }
        }, body);
        return (Array.isArray(j) && j[0] && j[0].translations && j[0].translations[0]
                && j[0].translations[0].text) || '';
    }
    // Free fallback: MyMemory (add MYMEMORY_EMAIL env to raise the daily quota)
    const emailParam = process.env.MYMEMORY_EMAIL ? ('&de=' + encodeURIComponent(process.env.MYMEMORY_EMAIL)) : '';
    const j = await httpsJson({
        method: 'GET', hostname: 'api.mymemory.translated.net',
        path: '/get?langpair=en|ar&q=' + encodeURIComponent(text) + emailParam
    });
    const t = j && j.responseData && j.responseData.translatedText;
    // MyMemory returns warning strings in upper-case when it can't translate
    if (!t || /MYMEMORY|QUOTA|INVALID/i.test(t)) return '';
    return t;
}

app.post('/translate', async (req, res) => {
    const items = (req.body && Array.isArray(req.body.texts)) ? req.body.texts : [];
    const out = {};
    for (const raw of items) {
        const key = String(raw == null ? '' : raw).trim();
        if (!key) continue;
        if (TRANSLATE_CACHE[key] !== undefined) { out[key] = TRANSLATE_CACHE[key]; continue; }
        try {
            const ar = await translateOne(key);
            TRANSLATE_CACHE[key] = ar;   // cache even empty, so we don't retry a failing string forever
            out[key] = ar;
        } catch (e) { out[key] = ''; }
    }
    res.json({ translations: out });
});

app.listen(PORT, () => {
    console.log(`Dubai SPA Form server running on port ${PORT}`);
});
