# 1441 Pizzeria - DotPe Frontend SPA & Backend Order Simulation

Complete extraction, reverse-engineered frontend Single-Page Application (SPA), cart/customization engine, and backend microservice simulation server for **1441 Pizzeria** (`https://1441pizzeria.dotpe.in/store/6/delivery`).

---

## 🚀 Features

- **Full Localized Frontend**: Extracted and patched Create-React-App / Webpack bundle (`index.html`, core runtime, dynamic route chunks, and CSS).
- **108 Real Menu Items across 16 Categories**: Fully parsed menu catalog ([`1441_pizzeria_thane_catalog.json`](1441_pizzeria_thane_catalog.json)) matching the actual Thane outlet (Krish's Pizza, Meat Cravers, woodfired pizzas, pastas, desserts, and drinks).
- **Interactive Pizza Customization Engine**: Complete options configuration for woodfired pizzas (Crust selection, Italian San Marzano / Peri Peri sauces, cheese types, and multi-select toppings).
- **Cart & Bill Breakdown Logic**: Real-time cart state synchronization, item deduplication, quantity increments/decrements, 5% GST, ₹25 packaging charge, and delivery fee calculations.
- **Standalone Offline Simulation Server**: Zero external dependencies — pure Python 3 HTTP server ([`server.py`](server.py)) that serves the SPA and mocks all DotPe backend REST APIs.
- **In-Depth Architectural Documentation**: Extensive reverse-engineering analysis in [`DOTPE_BACKEND_AND_ORDER_ARCHITECTURE.md`](DOTPE_BACKEND_AND_ORDER_ARCHITECTURE.md).

---

## 📁 Repository Structure

```
├── DOTPE_BACKEND_AND_ORDER_ARCHITECTURE.md   # Complete reverse-engineered architectural guide
├── 1441_pizzeria_thane_catalog.json          # Scraped 1441 Pizzeria catalog (16 categories, 108 items)
├── server.py                                 # Standalone Python HTTP simulation & mock server
├── index.html                                # Main React Single-Page Application HTML
├── manifest.json                             # Web app manifest
├── chunk_maps.json                           # Webpack runtime map of all 195 JS & CSS chunks
└── static/
    ├── js/                                   # Downloaded core & lazy-loaded route JS chunks
    │   ├── main.cc65a752.chunk.js            # App routing, Redux store, Axios HTTP interceptors
    │   ├── 56.85a3d6ce.chunk.js              # Vendor chunk (React, Redux, Sagas, Lodash)
    │   ├── 57.2b876dfd.chunk.js              # Storefront & category display chunk
    │   ├── 58.7912ff5e.chunk.js              # Item customization & variant selection chunk
    │   ├── 59.b1bba8bb.chunk.js              # Active Cart & bill calculation chunk
    │   ├── 66.74d89cee.chunk.js              # Thank you & live order tracking chunk
    │   └── ...                               # Additional route chunks (Address, OTP, Payment)
    └── css/                                  # Component stylesheets
```

---

## ⚡ Quick Start

### 1. Run the Offline Server
No `npm install` or external database required. Simply run:

```bash
python3 server.py
```

The server will start on port `8083`.

### 2. Open in Browser
- **Direct Storefront (Delivery)**: [http://localhost:8083/store/6/delivery](http://localhost:8083/store/6/delivery)
- **Active Cart & Checkout**: [http://localhost:8083/cart](http://localhost:8083/cart)

---

## 🛠 Simulated DotPe REST Endpoints

The mock server in [`server.py`](server.py) implements the following DotPe endpoints:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/merchant/external/cstore/:storeId` | Store branding, operational timings, and service options |
| `GET` | `/api/catalog/store/:storeId/menu` | Categorized menu hierarchy with customization options |
| `POST` | `/api/cart` | Cart synchronization and billing calculations (taxes, packaging, delivery) |
| `POST` | `/api/cart/validate` | Cart validation (stock status, pricing changes) |
| `POST` | `/api/cart/check/delivery` | Geofence and serviceability check |
| `GET` | `/api/userservice/user/login/:phone` | Customer OTP dispatch trigger |
| `POST` | `/api/userservice/user/verifyOtp` | Customer OTP authentication |
| `POST` | `/api/cart/checkout` | Order creation generating `orderID` and cryptographic `oHash` |
| `GET` | `/api/payment/v2/modes` | Enabled payment modes (Cards, UPI, Simpl, COD) |
| `POST` | `/api/payment/v2/transaction/initiate` | Payment gateway transaction initiation |
| `GET` | `/api/payment/v2/transaction/status/:txnId` | Payment verification polling |
| `GET` | `/api/morder/order/hash/detail/:oHash` | Real-time live order tracking |
| `GET` | `/api/invoice/fetch` | Tax invoice breakdown and receipt |

---

## 📖 Architecture & Order Logic Deep Dive

For the complete technical breakdown of:
- Webpack bundle chunk splitting
- Redux slices (`checkoutReducer`, `storeReducer`, `userReducer`, etc.) and localStorage persistence
- In-memory vs flattened backend cart representations
- Complete 80+ REST API catalog with request/response schemas
- End-to-end Mermaid sequence diagrams

Read **[`DOTPE_BACKEND_AND_ORDER_ARCHITECTURE.md`](DOTPE_BACKEND_AND_ORDER_ARCHITECTURE.md)**.
