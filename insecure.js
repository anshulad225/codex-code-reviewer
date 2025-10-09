const express = require('express');
const app = express();
const crypto = require('crypto');
const { exec } = require('child_process');
const mysql = require('mysql2');

const PASSWORD = 'super-secret-123'; // hardcoded secret

// UNSAFE: eval
app.get('/run', (req, res) => {
  const code = req.query.code;
  eval(code); // ⚠️ code injection
  res.send('ran');
});

// UNSAFE: command injection
app.get('/ping', (req, res) => {
  const host = req.query.host; // no validation
  exec('ping -c 1 ' + host, (err, out) => {
    if (err) return res.status(500).send(err.message);
    res.type('text').send(out);
  });
});

// UNSAFE: SQL injection
const conn = mysql.createConnection({host:'localhost', user:'root', database:'app'});
app.get('/user', (req, res) => {
  const id = req.query.id; // no sanitization
  const sql = "SELECT * FROM users WHERE id = " + id; // ⚠️ concat
  conn.query(sql, (err, rows) => {
    if (err) return res.status(500).send('db error');
    res.json(rows[0] || {});
  });
});

// WEAK CRYPTO: md5
function weakHash(s) { return crypto.createHash('md5').update(s).digest('hex'); }

app.listen(3000, () => console.log('insecure server on 3000'));