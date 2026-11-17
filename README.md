# Collaborative Book Resource Hub – Prototype

## Run
1. Install Node.js 18+ and MySQL 8.
2. `mysql -u root -p < schema.sql`
3. `copy .env.example .env` (or `cp`) and set DB_PASS
4. `npm install`
5. `npm start` → open http://localhost:3000
Admin (auto-created): admin@bookhub.com / admin123

## Demo script (review)
Register 3 users: Owner, Borrower (different browser/incognito each), plus admin.
A. Success: Owner lists book → Borrower requests → Owner approves → Borrower pays → Owner dispatches (tracking) → Borrower enters OTP (shown on their card) → delivered, escrow released → Borrower dispatches return → Owner confirms → completed → rate.
B. Owner never dispatches: after payment, Borrower clicks "Demo: dispatch deadline expired" → cancelled, refund, owner reliability -10.
C. Phone off: after dispatch, Borrower clicks "Demo: failed attempt" twice → returned, charges deducted, partial refund.
D. Complaint: after delivery, "Report damaged" → Admin resolves (refund/replace/dismiss).
E. Overdue: admin dashboard → reminders (use POST /api/admin/demo-overdue/:requestId to backdate a due date).

NOTE: payment/escrow, courier tracking, OTP SMS and verification are SIMULATED statuses, not live integrations.
