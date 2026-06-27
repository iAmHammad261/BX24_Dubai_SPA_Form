const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
const https   = require('https');

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

    // Bitrix image filenames often contain spaces — encode them for the upstream request.
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
