const fs = require('fs');
const path = './src/i18n/locales/en/translation.json';
try {
    const data = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(data);
    fs.writeFileSync(path, JSON.stringify(json, null, 2));
    console.log('JSON fixed and formatted');
} catch (e) {
    console.error('JSON Error:', e.message);
    const lines = fs.readFileSync(path, 'utf8').split('\n');
    console.error('Around the error:');
    const match = e.message.match(/at position (\d+)/);
    if (match) {
        const pos = parseInt(match[1]);
        const start = Math.max(0, pos - 100);
        const end = Math.min(fs.readFileSync(path, 'utf8').length, pos + 100);
        console.error(fs.readFileSync(path, 'utf8').substring(start, end));
    }
}
