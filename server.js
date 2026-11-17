require('dotenv').config();
const express = require('express'), mysql = require('mysql2/promise'), bcrypt = require('bcrypt'),
      jwt = require('jsonwebtoken'), path = require('path');
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'bookhub', connectionLimit: 10 });
const SECRET = process.env.JWT_SECRET || 'dev-secret';

// ---------- helpers ----------
const q = async (sql, p = []) => (await db.query(sql, p))[0];
const one = async (sql, p) => (await q(sql, p))[0];
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); bad(res, e.message, 500); });
const notify = (uid, msg) => q('INSERT INTO notifications(user_id,message) VALUES(?,?)', [uid, msg]);
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET); next(); }
  catch { bad(res, 'Please log in', 401); }
};
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : bad(res, 'Admin only', 403);
const getReq = id => one(`SELECT r.*, b.owner_id, b.title, b.mode, b.price, b.book_id AS bid, b.location
  FROM requests r JOIN books b ON b.book_id=r.book_id WHERE r.request_id=?`, [id]);
const setBook = (id, s) => q('UPDATE books SET availability=? WHERE book_id=?', [s, id]);

// ---------- auth ----------
app.post('/api/register', wrap(async (req, res) => {
  const { name, email, phone, city, address, password } = req.body;
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 'Valid name and email required');
  if (!/^[6-9]\d{9}$/.test(phone || '')) return bad(res, 'Enter a valid 10-digit Indian mobile number');
  if (!city || (password || '').length < 6) return bad(res, 'City and a password of 6+ characters required');
  if (await one('SELECT 1 FROM users WHERE email=?', [email])) return bad(res, 'Email already registered');
  await q('INSERT INTO users(name,email,phone,city,address,password_hash) VALUES(?,?,?,?,?,?)',
    [name, email, phone, city, address || '', await bcrypt.hash(password, 10)]);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE email=?', [req.body.email]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return bad(res, 'Invalid credentials', 401);
  const token = jwt.sign({ id: u.user_id, role: u.role, name: u.name, city: u.city }, SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.user_id, name: u.name, role: u.role, city: u.city, phone: u.phone, address: u.address } });
}));

// ---------- books ----------
const SORTS = { new: 'b.book_id DESC', low: 'b.price ASC, b.book_id DESC', high: 'b.price DESC, b.book_id DESC',
  rating: 'owner_rating DESC, b.book_id DESC' };

app.get('/api/books', wrap(async (req, res) => {
  const { search = '', category = '', location = '', status = '', mode = '', sort = '' } = req.query;
  const like = `%${search}%`;
  const order = SORTS[sort] || SORTS.new;
  const rows = await q(`SELECT b.book_id, b.owner_id, b.title, b.author, b.category, b.book_condition, b.mode, b.price,
      b.location, b.photo, b.availability, u.name owner_name, u.reliability,
      (SELECT ROUND(AVG(rating),1) FROM reviews WHERE user_id=b.owner_id) owner_rating
    FROM books b JOIN users u ON u.user_id=b.owner_id
    WHERE (b.title LIKE ? OR b.author LIKE ?) AND b.category LIKE ? AND b.location LIKE ?
      AND b.availability NOT IN ('sold','donated') AND (?='' OR b.mode=?) AND (?='' OR b.availability=?) ORDER BY ${order}`,
    [like, like, `%${category}%`, `%${location}%`, mode, mode, status, status]);
  res.json(rows);
}));

app.post('/api/books', auth, wrap(async (req, res) => {
  const b = req.body;
  if (!b.title) return bad(res, 'Title required');
  if (!['lend', 'donate', 'exchange', 'sell'].includes(b.mode || 'lend')) return bad(res, 'Invalid listing type');
  if (b.mode === 'sell' && !(Number(b.price) > 0)) return bad(res, 'Enter a selling price');
  await q(`INSERT INTO books(owner_id,title,author,category,book_condition,mode,price,location,photo)
    VALUES(?,?,?,?,?,?,?,?,?)`, [req.user.id, b.title, b.author, b.category, b.book_condition || 'Good',
    b.mode || 'lend', b.mode === 'donate' ? 0 : Number(b.price) || 0, b.location || req.user.city, b.photo || null]);
  res.json({ ok: true });
}));

app.get('/api/books/mine', auth, wrap(async (req, res) => {
  res.json(await q('SELECT book_id,title,author,category,book_condition,mode,price,location,photo,availability FROM books WHERE owner_id=? ORDER BY book_id DESC', [req.user.id]));
}));

// ---------- wishlist (saved books) ----------
app.get('/api/wishlist/ids', auth, wrap(async (req, res) => {
  const rows = await q('SELECT book_id FROM saved_books WHERE user_id=?', [req.user.id]);
  res.json(rows.map(r => r.book_id));
}));
app.get('/api/wishlist', auth, wrap(async (req, res) => {
  res.json(await q(`SELECT b.book_id, b.owner_id, b.title, b.author, b.category, b.book_condition, b.mode, b.price,
      b.location, b.photo, b.availability, u.name owner_name, u.reliability,
      (SELECT ROUND(AVG(rating),1) FROM reviews WHERE user_id=b.owner_id) owner_rating
    FROM saved_books s JOIN books b ON b.book_id=s.book_id JOIN users u ON u.user_id=b.owner_id
    WHERE s.user_id=? ORDER BY s.saved_at DESC`, [req.user.id]));
}));
app.post('/api/wishlist/:bookId', auth, wrap(async (req, res) => {
  const b = await one('SELECT owner_id FROM books WHERE book_id=?', [req.params.bookId]);
  if (!b) return bad(res, 'Book not found', 404);
  if (b.owner_id === req.user.id) return bad(res, 'You cannot save your own book');
  await q('INSERT IGNORE INTO saved_books(user_id,book_id) VALUES(?,?)', [req.user.id, req.params.bookId]);
  res.json({ ok: true });
}));
app.delete('/api/wishlist/:bookId', auth, wrap(async (req, res) => {
  await q('DELETE FROM saved_books WHERE user_id=? AND book_id=?', [req.user.id, req.params.bookId]);
  res.json({ ok: true });
}));

// ---------- requests (borrow / buy flow) ----------
app.post('/api/requests', auth, wrap(async (req, res) => {
  const me = await one('SELECT cancel_count FROM users WHERE user_id=?', [req.user.id]);
  if (me.cancel_count >= 3) return bad(res, 'Borrowing restricted due to repeated cancellations', 403);
  const book = await one('SELECT * FROM books WHERE book_id=?', [req.body.book_id]);
  if (!book || book.availability !== 'available') return bad(res, 'Book is not available');
  if (book.owner_id === req.user.id) return bad(res, 'You cannot request your own book');
  if (await one(`SELECT 1 FROM requests WHERE book_id=? AND borrower_id=?
      AND request_status IN ('requested','approved','paid','dispatched')`, [book.book_id, req.user.id]))
    return bad(res, 'You already have an active request for this book');
  await q('INSERT INTO requests(book_id,borrower_id) VALUES(?,?)', [book.book_id, req.user.id]);
  await notify(book.owner_id, `${req.user.name} requested "${book.title}"`);
  res.json({ ok: true });
}));

app.get('/api/requests/mine', auth, wrap(async (req, res) => {
  const rows = await q(`SELECT r.*, b.title, b.mode, b.owner_id, b.price book_price, b.location book_location, u1.name borrower_name, u2.name owner_name,
      p.amount, p.delivery_charge, p.payment_status, p.refund_amount, d.tracking_id, d.attempts, d.otp
    FROM requests r JOIN books b ON b.book_id=r.book_id
    JOIN users u1 ON u1.user_id=r.borrower_id JOIN users u2 ON u2.user_id=b.owner_id
    LEFT JOIN payments p ON p.request_id=r.request_id LEFT JOIN deliveries d ON d.request_id=r.request_id
    WHERE r.borrower_id=? OR b.owner_id=? ORDER BY r.request_id DESC`, [req.user.id, req.user.id]);
  rows.forEach(r => { if (r.borrower_id !== req.user.id) delete r.otp; });   // only borrower sees OTP
  res.json(rows);
}));

// ---------- chat between owner and buyer (5 messages until the owner accepts) ----------
const CHAT_LIMIT = 5, CHAT_CLOSED = ['rejected', 'cancelled'];
const chatRequest = async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || (r.borrower_id !== req.user.id && r.owner_id !== req.user.id)) { bad(res, 'Not allowed', 403); return null; }
  return r;
};

app.get('/api/requests/:id/messages', auth, wrap(async (req, res) => {
  const r = await chatRequest(req, res); if (!r) return;
  const messages = await q('SELECT msg_id, sender_id, body, created_at FROM messages WHERE request_id=? ORDER BY msg_id ASC', [r.request_id]);
  const other = await one('SELECT name FROM users WHERE user_id=?', [r.owner_id === req.user.id ? r.borrower_id : r.owner_id]);
  res.json({
    title: r.title, other_name: other ? other.name : 'User', messages,
    closed: CHAT_CLOSED.includes(r.request_status),
    limit_left: r.request_status === 'requested' ? Math.max(0, CHAT_LIMIT - messages.length) : null
  });
}));

app.post('/api/requests/:id/messages', auth, wrap(async (req, res) => {
  const r = await chatRequest(req, res); if (!r) return;
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) return bad(res, 'Type a message first');
  if (CHAT_CLOSED.includes(r.request_status)) return bad(res, 'This chat is closed because the request was rejected or cancelled', 403);
  if (r.request_status === 'requested') {
    const c = (await one('SELECT COUNT(*) c FROM messages WHERE request_id=?', [r.request_id])).c;
    if (c >= CHAT_LIMIT) return bad(res, `Message limit (${CHAT_LIMIT}) reached. You can chat freely once the owner accepts the request.`, 403);
  }
  await q('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)', [r.request_id, req.user.id, body]);
  await notify(r.owner_id === req.user.id ? r.borrower_id : r.owner_id, `💬 New message about "${r.title}"`);
  res.json({ ok: true });
}));

// owner approves / rejects. Approval atomically reserves the book (no double booking)
app.put('/api/requests/:id/decision', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.owner_id !== req.user.id || r.request_status !== 'requested') return bad(res, 'Not allowed');
  if (req.body.action === 'reject') {
    await q("UPDATE requests SET request_status='rejected' WHERE request_id=?", [r.request_id]);
    await notify(r.borrower_id, `Your request for "${r.title}" was rejected`);
    return res.json({ ok: true });
  }
  const hold = await q("UPDATE books SET availability='reserved' WHERE book_id=? AND availability='available'", [r.bid]);
  if (!hold.affectedRows) return bad(res, 'Book already reserved for someone else');
  await q("UPDATE requests SET request_status='approved' WHERE request_id=?", [r.request_id]);
  await q("UPDATE requests SET request_status='rejected' WHERE book_id=? AND request_status='requested'", [r.bid]);
  await notify(r.borrower_id, `Approved! Confirm address and pay for "${r.title}"`);
  res.json({ ok: true });
}));

// borrower confirms address + availability + alternate phone, pays into simulated escrow
app.post('/api/requests/:id/pay', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  const { address, alt_phone, available } = req.body;
  if (!r || r.borrower_id !== req.user.id || r.request_status !== 'approved') return bad(res, 'Not allowed');
  if (!address || address.length < 10) return bad(res, 'Enter a complete delivery address');
  if (!/^[6-9]\d{9}$/.test(alt_phone || '')) return bad(res, 'Alternate phone number required');
  if (!available) return bad(res, 'Confirm you will be available for delivery');
  const delivery = r.location && r.location.toLowerCase() === req.user.city.toLowerCase() ? 30 : 80;
  const bookAmt = Number(r.price);
  await q('INSERT INTO payments(request_id,book_amount,delivery_charge,amount) VALUES(?,?,?,?)',
    [r.request_id, bookAmt, delivery, bookAmt + delivery]);
  await q(`UPDATE requests SET request_status='paid', address=?, alt_phone=?,
    dispatch_deadline=DATE_ADD(NOW(), INTERVAL 2 DAY) WHERE request_id=?`, [address, alt_phone, r.request_id]);
  await notify(r.owner_id, `Payment held in escrow for "${r.title}". Dispatch within 2 days.`);
  res.json({ ok: true });
}));

// owner dispatches with tracking id + condition photo; OTP generated for borrower
app.post('/api/requests/:id/dispatch', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.owner_id !== req.user.id || r.request_status !== 'paid') return bad(res, 'Not allowed');
  if (!req.body.tracking_id) return bad(res, 'Tracking number required');
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  await q('INSERT INTO deliveries(request_id,tracking_id,condition_note,dispatch_photo,otp) VALUES(?,?,?,?,?)',
    [r.request_id, req.body.tracking_id, req.body.condition_note || '', req.body.photo || null, otp]);
  await q("UPDATE requests SET request_status='dispatched' WHERE request_id=?", [r.request_id]);
  await notify(r.borrower_id, `"${r.title}" dispatched (tracking ${req.body.tracking_id}). Delivery OTP: ${otp}`);
  res.json({ ok: true });
}));

// delivery: success (correct OTP) or simulated failed attempt (2 attempts then return-to-sender)
app.post('/api/requests/:id/delivery', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.borrower_id !== req.user.id || r.request_status !== 'dispatched') return bad(res, 'Not allowed');
  const d = await one('SELECT * FROM deliveries WHERE request_id=?', [r.request_id]);
  if (req.body.success) {
    if (req.body.otp !== d.otp) return bad(res, 'Incorrect OTP');
    await q("UPDATE deliveries SET delivery_status='delivered' WHERE request_id=?", [r.request_id]);
    await q("UPDATE payments SET payment_status='released' WHERE request_id=?", [r.request_id]); // escrow released
    if (['donate', 'sell'].includes(r.mode)) {
      await q("UPDATE requests SET request_status='completed' WHERE request_id=?", [r.request_id]);
      await setBook(r.bid, r.mode === 'sell' ? 'sold' : 'donated');
    } else {
      await q("UPDATE requests SET request_status='delivered', due_date=DATE_ADD(NOW(), INTERVAL 14 DAY) WHERE request_id=?", [r.request_id]);
      await setBook(r.bid, 'borrowed');
    }
    await notify(r.owner_id, `"${r.title}" delivered. Escrow released.`);
    return res.json({ ok: true });
  }
  const attempts = d.attempts + 1;
  await q('UPDATE deliveries SET attempts=? WHERE request_id=?', [attempts, r.request_id]);
  if (attempts < 2) { await notify(r.borrower_id, 'Delivery attempt 1 failed. Second attempt will be made.'); return res.json({ ok: true, msg: 'Attempt 1 failed' }); }
  const p = await one('SELECT * FROM payments WHERE request_id=?', [r.request_id]);
  const cost = Math.min(Number(p.delivery_charge) * 2, Number(p.amount));        // forward + return charges
  await q("UPDATE payments SET payment_status='partially_refunded', refund_amount=? WHERE request_id=?", [p.amount - cost, r.request_id]);
  await q("UPDATE deliveries SET delivery_status='failed' WHERE request_id=?", [r.request_id]);
  await q("UPDATE requests SET request_status='delivery_failed' WHERE request_id=?", [r.request_id]);
  await setBook(r.bid, 'available');
  await notify(r.borrower_id, `Delivery failed twice. Book returned; ₹${cost} charges deducted, ₹${p.amount - cost} refunded.`);
  await notify(r.owner_id, `"${r.title}" returned to you after 2 failed delivery attempts.`);
  res.json({ ok: true, msg: 'Delivery failed twice, return started' });
}));

// borrower or admin cancels before dispatch; paid money is refunded (simulated)
app.post('/api/requests/:id/cancel', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || (r.borrower_id !== req.user.id && req.user.role !== 'admin')) return bad(res, 'Not allowed');
  if (!['requested', 'approved', 'paid'].includes(r.request_status)) return bad(res, 'Cannot cancel at this stage');
  if (r.request_status === 'paid') await q("UPDATE payments SET payment_status='refunded', refund_amount=amount WHERE request_id=?", [r.request_id]);
  if (r.request_status !== 'requested') await setBook(r.bid, 'available');
  await q("UPDATE requests SET request_status='cancelled' WHERE request_id=?", [r.request_id]);
  await q('UPDATE users SET cancel_count=cancel_count+1 WHERE user_id=?', [r.borrower_id]);
  await notify(r.owner_id, `Request for "${r.title}" was cancelled.`);
  res.json({ ok: true });
}));

// DEMO: dispatch deadline expires -> auto-cancel, full refund, owner reliability drops
app.post('/api/requests/:id/expire-dispatch', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.request_status !== 'paid' || (r.borrower_id !== req.user.id && req.user.role !== 'admin')) return bad(res, 'Not allowed');
  await q("UPDATE payments SET payment_status='refunded', refund_amount=amount WHERE request_id=?", [r.request_id]);
  await q("UPDATE requests SET request_status='cancelled' WHERE request_id=?", [r.request_id]);
  await q('UPDATE users SET reliability=GREATEST(reliability-10,0) WHERE user_id=?', [r.owner_id]);
  await setBook(r.bid, 'available');
  await notify(r.borrower_id, 'Owner did not dispatch in time. Full refund initiated.');
  await notify(r.owner_id, 'You missed the dispatch deadline. Your reliability score dropped.');
  res.json({ ok: true });
}));

// returns
app.post('/api/requests/:id/return', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.borrower_id !== req.user.id || r.request_status !== 'delivered') return bad(res, 'Not allowed');
  await q("UPDATE requests SET request_status='return_dispatched', return_tracking=? WHERE request_id=?", [req.body.tracking || 'N/A', r.request_id]);
  await notify(r.owner_id, `"${r.title}" is on its way back to you.`);
  res.json({ ok: true });
}));
app.post('/api/requests/:id/return-confirm', auth, wrap(async (req, res) => {
  const r = await getReq(req.params.id);
  if (!r || r.owner_id !== req.user.id || r.request_status !== 'return_dispatched') return bad(res, 'Not allowed');
  await q("UPDATE requests SET request_status='completed', overdue=0 WHERE request_id=?", [r.request_id]);
  await setBook(r.bid, 'available');
  await notify(r.borrower_id, `Return of "${r.title}" confirmed. Thank you!`);
  res.json({ ok: true });
}));

// ---------- complaints, reviews, notifications ----------
app.post('/api/complaints', auth, wrap(async (req, res) => {
  const r = await getReq(req.body.request_id);
  if (!r || r.borrower_id !== req.user.id || !['delivered', 'completed', 'return_dispatched'].includes(r.request_status)) return bad(res, 'Not allowed');
  await q('INSERT INTO complaints(request_id,raised_by,description,evidence) VALUES(?,?,?,?)',
    [r.request_id, req.user.id, req.body.description, req.body.evidence || null]);
  await notify(r.owner_id, `A complaint was raised on "${r.title}". Admin will review.`);
  res.json({ ok: true });
}));

app.post('/api/reviews', auth, wrap(async (req, res) => {
  const r = await getReq(req.body.request_id);
  if (!r || ![r.borrower_id, r.owner_id].includes(req.user.id) || r.request_status !== 'completed') return bad(res, 'Review allowed after completion');
  const target = req.user.id === r.borrower_id ? r.owner_id : r.borrower_id;
  const rating = Math.min(5, Math.max(1, Number(req.body.rating)));
  await q('INSERT IGNORE INTO reviews(request_id,reviewer_id,user_id,rating,feedback) VALUES(?,?,?,?,?)',
    [r.request_id, req.user.id, target, rating, req.body.feedback || '']);
  res.json({ ok: true });
}));

app.get('/api/notifications', auth, wrap(async (req, res) => {
  res.json(await q('SELECT * FROM notifications WHERE user_id=? ORDER BY notification_id DESC LIMIT 50', [req.user.id]));
}));
app.put('/api/notifications/read', auth, wrap(async (req, res) => {
  await q('UPDATE notifications SET read_status=1 WHERE user_id=?', [req.user.id]); res.json({ ok: true });
}));

// ---------- admin ----------
app.get('/api/admin/overview', auth, adminOnly, wrap(async (req, res) => {
  res.json({
    counts: await one(`SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM books) books,
      (SELECT COUNT(*) FROM requests) requests, (SELECT COUNT(*) FROM requests WHERE overdue=1) overdue,
      (SELECT COUNT(*) FROM complaints WHERE status='open') open_complaints`),
    users: await q('SELECT user_id,name,email,city,reliability,cancel_count FROM users ORDER BY user_id DESC'),
    complaints: await q(`SELECT c.*, b.title FROM complaints c JOIN requests r ON r.request_id=c.request_id
      JOIN books b ON b.book_id=r.book_id ORDER BY c.status, c.complaint_id DESC`),
    payments: await q('SELECT * FROM payments ORDER BY payment_id DESC LIMIT 20')
  });
}));
app.put('/api/admin/complaints/:id', auth, adminOnly, wrap(async (req, res) => {
  const { resolution } = req.body;
  const c = await one('SELECT * FROM complaints WHERE complaint_id=?', [req.params.id]);
  if (!c || !['refund', 'replace', 'dismiss'].includes(resolution)) return bad(res, 'Invalid');
  if (resolution === 'refund') await q("UPDATE payments SET payment_status='refunded', refund_amount=amount WHERE request_id=?", [c.request_id]);
  await q("UPDATE complaints SET status='resolved', resolution=? WHERE complaint_id=?", [resolution, c.complaint_id]);
  await notify(c.raised_by, `Your complaint was resolved: ${resolution}.`);
  res.json({ ok: true });
}));
// due-date reminders + overdue flags (run from the dashboard button, or schedule with cron)
app.post('/api/admin/reminders', auth, adminOnly, wrap(async (req, res) => {
  const due = await q(`SELECT r.request_id, r.borrower_id, r.due_date, b.title FROM requests r JOIN books b ON b.book_id=r.book_id
    WHERE r.request_status='delivered' AND r.due_date < DATE_ADD(NOW(), INTERVAL 2 DAY)`);
  for (const r of due) {
    const late = new Date(r.due_date) < new Date();
    if (late) await q('UPDATE requests SET overdue=1 WHERE request_id=?', [r.request_id]);
    await notify(r.borrower_id, late ? `OVERDUE: please return "${r.title}"` : `Reminder: "${r.title}" is due soon`);
  }
  res.json({ reminded: due.length });
}));
app.post('/api/admin/demo-overdue/:id', auth, adminOnly, wrap(async (req, res) => {   // demo helper
  await q("UPDATE requests SET due_date=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE request_id=? AND request_status='delivered'", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- start ----------
(async () => {
  await q("ALTER TABLE books MODIFY mode ENUM('lend','donate','exchange','sell') DEFAULT 'lend'");
  await q("ALTER TABLE books MODIFY availability ENUM('available','reserved','borrowed','donated','sold') DEFAULT 'available'");
  await q(`CREATE TABLE IF NOT EXISTS saved_books (
    user_id INT NOT NULL, book_id INT NOT NULL, saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, book_id))`);
  await q(`CREATE TABLE IF NOT EXISTS messages (
    msg_id INT AUTO_INCREMENT PRIMARY KEY, request_id INT NOT NULL, sender_id INT NOT NULL,
    body VARCHAR(500) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (request_id))`);
  if (!(await one("SELECT 1 FROM users WHERE role='admin'")))
    await q("INSERT INTO users(name,email,phone,city,password_hash,role) VALUES('Admin','admin@bookhub.com','9000000000','Basar',?, 'admin')",
      [await bcrypt.hash('admin123', 10)]);
  app.listen(process.env.PORT || 3000, () => console.log('Book Hub running on http://localhost:' + (process.env.PORT || 3000)));
})();