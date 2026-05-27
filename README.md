# HoldKart Customer — Node.js Backend

  ## Quick Start

  ### 1. Install dependencies
  ```bash
  npm install
  ```

  ### 2. Configure database
  Open `.env` and set your MySQL password:
  ```
  DB_HOST=localhost
  DB_USER=root
  DB_PASSWORD=your_actual_mysql_password   ← CHANGE THIS
  DB_NAME=holdkart
  ```

  > If your MySQL root has **no password**, leave `DB_PASSWORD=` empty.

  ### 3. Run the SQL schema
  The customer tables live in the **same `holdkart` database** as the seller.
  Run after the seller schema:
  ```bash
  mysql -u root -p holdkart < schema.sql
  ```
  Or paste schema.sql into MySQL Workbench with the `holdkart` DB selected.

  ### 4. Start the server
  ```bash
  npm run dev   # development (nodemon)
  npm start     # production
  ```
  Server starts on **http://localhost:8081**

  ---

  ## API Routes

  | Prefix | Description |
  |--------|-------------|
  | POST /api/customer/auth/register | Register |
  | POST /api/customer/auth/login | Login |
  | POST /api/customer/auth/forgot-password | Forgot password |
  | POST /api/customer/auth/reset-password | Reset password |
  | GET  /api/customer/products | List products |
  | GET  /api/customer/products/:id | Product detail |
  | GET/POST/PUT/DELETE /api/customer/cart | Cart CRUD |
  | GET/POST/DELETE /api/customer/wishlist | Wishlist |
  | POST /api/customer/orders | Place order |
  | GET  /api/customer/orders | List orders |
  | GET  /api/customer/orders/:id | Order detail |
  | GET  /api/customer/profile | Get profile |
  | PUT  /api/customer/profile | Update profile |
  | GET/POST /api/customer/reviews | Reviews |
  | GET/POST /api/customer/complaints | Complaints |
  | GET/POST /api/customer/notifications | Notifications |
  | GET/POST /api/customer/campaigns | Campaigns |
  | POST /api/customer/payment/create-order | Razorpay |
  | POST /api/customer/payment/verify | Verify payment |
  