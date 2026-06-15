const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Install / setup screen — Bitrix calls this on app install
app.all('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// The SPA Form tab rendered inside the Deal
app.all('/spa_form.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'spa_form.html'));
});

app.listen(PORT, () => {
    console.log(`Dubai SPA Form server running on port ${PORT}`);
});