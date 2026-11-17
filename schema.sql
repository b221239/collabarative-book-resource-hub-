CREATE DATABASE IF NOT EXISTS bookhub;
USE bookhub;

CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  phone VARCHAR(15) NOT NULL,
  city VARCHAR(60) NOT NULL,
  address VARCHAR(255),
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('user','admin') DEFAULT 'user',
  verification_status ENUM('verified','pending') DEFAULT 'verified', -- simulated verification
  reliability INT DEFAULT 100,           -- drops when owner fails to dispatch
  cancel_count INT DEFAULT 0,            -- 3+ cancellations => borrowing restricted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE books (
  book_id INT AUTO_INCREMENT PRIMARY KEY,
  owner_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  author VARCHAR(120),
  category VARCHAR(60),
  book_condition ENUM('New','Good','Fair','Worn') DEFAULT 'Good',
  mode ENUM('lend','donate','exchange') DEFAULT 'lend',
  price DECIMAL(8,2) DEFAULT 0,          -- borrowing fee / deposit (0 for donation)
  location VARCHAR(60),
  photo LONGTEXT,                         -- base64 data URL (prototype only)
  availability ENUM('available','reserved','borrowed','donated') DEFAULT 'available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(user_id)
);

CREATE TABLE requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  book_id INT NOT NULL,
  borrower_id INT NOT NULL,
  request_status ENUM('requested','approved','rejected','paid','dispatched','delivered',
                      'return_dispatched','completed','cancelled','delivery_failed') DEFAULT 'requested',
  address VARCHAR(255),
  alt_phone VARCHAR(15),
  dispatch_deadline DATETIME,
  due_date DATETIME,                      -- return management
  return_tracking VARCHAR(60),
  overdue TINYINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (book_id) REFERENCES books(book_id),
  FOREIGN KEY (borrower_id) REFERENCES users(user_id)
);

CREATE TABLE payments (
  payment_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL UNIQUE,
  book_amount DECIMAL(8,2),
  delivery_charge DECIMAL(8,2),
  amount DECIMAL(8,2),
  payment_status ENUM('held','released','refunded','partially_refunded') DEFAULT 'held', -- simulated escrow
  refund_amount DECIMAL(8,2) DEFAULT 0,
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE deliveries (
  delivery_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL UNIQUE,
  tracking_id VARCHAR(60),
  condition_note VARCHAR(255),
  dispatch_photo LONGTEXT,
  otp CHAR(6),
  attempts INT DEFAULT 0,
  delivery_status ENUM('in_transit','delivered','failed') DEFAULT 'in_transit',
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE complaints (
  complaint_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  raised_by INT NOT NULL,
  description TEXT,
  evidence LONGTEXT,
  status ENUM('open','resolved') DEFAULT 'open',
  resolution ENUM('refund','replace','dismiss'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE reviews (
  review_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  user_id INT NOT NULL,                   -- person being reviewed
  rating TINYINT CHECK (rating BETWEEN 1 AND 5),
  feedback VARCHAR(255),
  UNIQUE KEY one_review (request_id, reviewer_id)
);

CREATE TABLE notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  message VARCHAR(255),
  read_status TINYINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
