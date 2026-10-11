#!/usr/bin/env python3
"""
DotPe 1441 Pizzeria - Offline Simulation Server & API Mock
Reverse-Engineered Full-Stack Standalone Server
"""

import http.server
import json
import mimetypes
import os
import sys
import time
import urllib.parse
from http import HTTPStatus
PORT = 8083
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(BASE_DIR, "1441_pizzeria_thane_catalog.json")
if not os.path.exists(CATALOG_PATH):
    CATALOG_PATH = os.path.join(os.path.dirname(BASE_DIR), "1441_pizzeria_thane_catalog.json")

# In-Memory State
SESSION_STATE = {
    "cart": {},
    "orders": {},
    "users": {
        "9876543210": {
            "userId": "usr_1441_99",
            "name": "Guest Customer",
            "phone": "9876543210",
            "addresses": [
                {
                    "addressId": "addr_101",
                    "address1": "Flat 402, Sunshine Heights",
                    "address2": "Ghodbunder Road",
                    "city": "Thane",
                    "pincode": "400607",
                    "tag": "Home",
                    "latitude": 19.2183,
                    "longitude": 72.9781
                }
            ]
        }
    }
}

def load_catalog_data():
    """Transforms scraped 1441 Pizzeria catalog into DotPe storeMenu schema."""
    if not os.path.exists(CATALOG_PATH):
        print(f"Warning: Catalog file not found at {CATALOG_PATH}")
        return [], {}

    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog_raw = json.load(f)

    categories_list = []
    menu_items_dict = {}
    item_id_counter = 1000

    for cat_idx, cat_obj in enumerate(catalog_raw.get("categories", []), 1):
        c_name = cat_obj.get("category", f"Category {cat_idx}")
        c_item_ids = []

        for it in cat_obj.get("items", []):
            item_id_counter += 1
            i_id = item_id_counter
            c_item_ids.append(i_id)

            name = it.get("name", "")
            price = float(it.get("price", 0))
            is_customizable = "Y" if it.get("customizable") else "N"
            desc = it.get("description", "")
            is_veg = not any(w in name.lower() or w in desc.lower() for w in [
                "chicken", "meat", "pork", "pepperoni", "salami", "sausage", "seafood", "fish", "tuna"
            ])

            options = []
            if is_customizable == "Y":
                options.append({
                    "title": "Select Crust",
                    "mandatory": True,
                    "min": 1,
                    "max": 1,
                    "options": [
                        {"id": f"crust_thin_{i_id}", "name": "Traditional Thin Crust", "price": 0},
                        {"id": f"crust_cheese_{i_id}", "name": "Cheese Burst Crust", "price": 120}
                    ]
                })
                options.append({
                    "title": "Select Sauce",
                    "mandatory": True,
                    "min": 1,
                    "max": 1,
                    "options": [
                        {"id": f"sauce_italian_{i_id}", "name": "Classic Italian Tomato Sauce", "price": 0},
                        {"id": f"sauce_periperi_{i_id}", "name": "Spicy Peri Peri Sauce", "price": 30}
                    ]
                })
                options.append({
                    "title": "Extra Toppings",
                    "mandatory": False,
                    "min": 0,
                    "max": 5,
                    "options": [
                        {"id": f"top_cheese_{i_id}", "name": "Extra Mozzarella Cheese", "price": 75},
                        {"id": f"top_olives_{i_id}", "name": "Black Olives", "price": 45},
                        {"id": f"top_jalapeno_{i_id}", "name": "Jalapenos", "price": 45},
                        {"id": f"top_mushroom_{i_id}", "name": "Grilled Mushrooms", "price": 60}
                    ]
                })

            menu_items_dict[str(i_id)] = {
                "itemID": i_id,
                "categoryID": cat_idx,
                "itemName": name,
                "price": price,
                "basePrice": price,
                "description": desc,
                "image": it.get("image", ""),
                "isVegetarian": is_veg,
                "isCustomizable": is_customizable,
                "itemSaleType": "delivery",
                "itemType": "standard",
                "options": options
            }

        categories_list.append({
            "categoryId": cat_idx,
            "categoryName": c_name,
            "itemIDs": c_item_ids
        })

    return categories_list, menu_items_dict

CATEGORIES_DATA, MENU_ITEMS_DATA = load_catalog_data()


class DotPeHandler(http.server.SimpleHTTPRequestHandler):
    """Custom HTTP handler that serves DotPe SPA assets and mocks backend REST endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _send_json(self, data, status_code=200):
        response_bytes = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id, app_version")
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_OPTIONS(self):
        """Handle CORS pre-flight requests."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id, app_version")
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        query = urllib.parse.parse_qs(url.query)

        # 1. API: Store Metadata
        if path.startswith("/api/merchant/external/cstore/") or path.startswith("/api/merchant/external/store/"):
            if "/menu" in path:
                return self._handle_get_menu(query)
            return self._handle_get_cstore(path, query)

        # 2. API: Merchant Info
        if path == "/api/merchant/external/merchant/info":
            return self._send_json({
                "status": True,
                "data": {
                    "merchant": {
                        "merchantId": 1001,
                        "merchantName": "1441 Pizzeria",
                        "logo": "https://cdn.dotpe.in/merchants/1441/logo.png"
                    }
                }
            })

        # 3. API: Promotional Banners
        if "/banners" in path:
            return self._send_json({
                "status": True,
                "data": {
                    "promoBanners": [
                        {
                            "id": 1,
                            "imageUrl": "https://cdn.dotpe.in/merchants/1441/banners/banner1.jpg",
                            "title": "Authentic Wood-fired Pizzas",
                            "subTitle": "Crafted with Italian San Marzano Tomatoes"
                        }
                    ]
                }
            })

        # 4. API: Catalog Menu
        if path.startswith("/api/catalog/store/") and path.endswith("/menu"):
            return self._handle_get_menu(query)

        # 5. API: Promo Details
        if path == "/api/promo/details" or path == "/api/promo/auto":
            return self._send_json({
                "status": True,
                "data": {
                    "coupons": [
                        {
                            "code": "PIZZA1441",
                            "discount": 50.0,
                            "minOrder": 299.0,
                            "description": "Flat ₹50 OFF on Woodfired Pizzas"
                        }
                    ]
                }
            })

        # 6. API: Payment Modes
        if path == "/api/payment/v2/modes":
            return self._send_json({
                "status": True,
                "data": {
                    "modes": [
                        {"id": "razorpay", "name": "Cards / UPI / NetBanking", "type": "gateway", "enabled": True},
                        {"id": "simpl", "name": "Simpl 1-Tap Pay Later", "type": "paylater", "enabled": True},
                        {"id": "cod", "name": "Cash on Delivery", "type": "offline", "enabled": True}
                    ]
                }
            })

        # 7. API: Serviceability Check
        if path == "/api/location/serviceability/get":
            return self._send_json({
                "status": True,
                "data": {
                    "isServiceable": True,
                    "deliveryFee": 40.0,
                    "estimatedDeliveryTimeMinutes": 35
                }
            })

        # 8. API: User Login / OTP Trigger
        if path.startswith("/api/userservice/user/login/"):
            phone = path.split("/")[-1]
            return self._send_json({
                "status": True,
                "data": {
                    "otpSent": True,
                    "phone": phone,
                    "message": "OTP 1234 sent successfully"
                }
            })

        # 9. API: User Profile by Phone
        if path.startswith("/api/userservice/user/v2/getByPhone/"):
            phone = path.split("/")[-1]
            user = SESSION_STATE["users"].get(phone, {
                "userId": f"usr_{phone[-4:]}",
                "name": "Guest Customer",
                "phone": phone
            })
            return self._send_json({"status": True, "data": {"user": user}})

        # 10. API: Address List
        if path.startswith("/api/userservice/address/v2/getByPhone/"):
            phone = path.split("/")[-1]
            user = SESSION_STATE["users"].get(phone, {})
            addresses = user.get("addresses", [])
            return self._send_json({"status": True, "data": {"addresses": addresses}})

        # 11. API: Payment Transaction Status Polling
        if path.startswith("/api/payment/v2/transaction/status/"):
            txn_id = path.split("/")[-1]
            return self._send_json({
                "status": 200,
                "data": {
                    "status": "SUCCESS",
                    "transactionId": txn_id,
                    "paymentStatus": 3,
                    "message": "Payment verified successfully"
                }
            })

        # 12. API: Order Details & Live Tracking
        if path.startswith("/api/morder/order/hash/detail/"):
            o_hash = path.split("/")[-1]
            order = SESSION_STATE["orders"].get(o_hash, {
                "orderID": f"DP1441_{o_hash[:6].upper()}",
                "oHash": o_hash,
                "orderStatus": "PREPARING",
                "paymentStatus": 3,
                "paymentMethod": "Razorpay UPI",
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "deliveryTimeMinutes": 30,
                "items": [
                    {"name": "Krish's Pizza (Thin Crust)", "quantity": 1, "price": 499.0},
                    {"name": "Choco Lava Cake", "quantity": 1, "price": 99.0}
                ],
                "billingDetails": {
                    "itemTotal": 598.0,
                    "taxes": 29.9,
                    "packaging": 25.0,
                    "delivery": 40.0,
                    "total": 692.9
                },
                "deliveryDetails": {
                    "address": "Flat 402, Sunshine Heights, Ghodbunder Road, Thane",
                    "customerPhone": "9876543210"
                }
            })
            return self._send_json({"status": True, "orderDetails": order})

        # 13. API: Tax Invoice Fetch
        if path == "/api/invoice/fetch":
            o_hash = query.get("hash", ["default_hash"])[0]
            return self._send_json({
                "status": True,
                "data": {
                    "invoiceNumber": f"INV-1441-{int(time.time())}",
                    "gstin": "27AABCU9603R1ZM",
                    "orderHash": o_hash,
                    "date": time.strftime("%d-%m-%Y"),
                    "breakup": {
                        "cgst": 14.95,
                        "sgst": 14.95,
                        "totalTax": 29.90
                    }
                }
            })

        # 14. Static Files & SPA Routing Fallback
        file_path = os.path.join(BASE_DIR, path.lstrip("/"))
        if os.path.exists(file_path) and not os.path.isdir(file_path):
            return super().do_GET()

        # SPA Fallback: Any other path serves index.html
        return self._serve_index_html()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        body = self._parse_json_body()

        # 1. API: Platform Analytics / Scan
        if path == "/api/perz/platform/scan":
            return self._send_json({"status": True, "message": "Scan recorded"})

        # 2. API: Cart Sync & Pricing Breakdown
        if path == "/api/cart":
            return self._handle_cart_sync(body)

        # 3. API: Cart Validation
        if path == "/api/cart/validate":
            return self._send_json({
                "status": 200,
                "data": {
                    "status": True,
                    "isCartValid": True,
                    "modifiedItems": {},
                    "removedItems": {}
                }
            })

        # 4. API: Delivery Check
        if path == "/api/cart/check/delivery":
            return self._send_json({
                "status": True,
                "data": {
                    "isServiceable": True,
                    "deliveryFee": 40.0,
                    "estimatedDeliveryTimeMinutes": 35,
                    "minOrderAmount": 200.0
                }
            })

        # 5. API: Verify OTP
        if path == "/api/userservice/user/verifyOtp":
            phone = body.get("phone", "9876543210")
            name = body.get("name", "Guest Customer")
            user_id = f"usr_{phone[-4:]}"
            SESSION_STATE["users"][phone] = {
                "userId": user_id,
                "name": name,
                "phone": phone,
                "addresses": SESSION_STATE["users"].get(phone, {}).get("addresses", [])
            }
            return self._send_json({
                "status": True,
                "data": {
                    "auth_token": f"mock_jwt_token_{int(time.time())}",
                    "user_id": user_id,
                    "user": {
                        "phone": phone,
                        "userName": name
                    }
                }
            })

        # 6. API: Address Create
        if path == "/api/userservice/address/create":
            phone = body.get("phone", "9876543210")
            addr_id = f"addr_{int(time.time() % 1000)}"
            new_addr = {
                "addressId": addr_id,
                "address1": body.get("address1", "Street 1"),
                "address2": body.get("address2", "Area"),
                "city": body.get("city", "Thane"),
                "pincode": body.get("pincode", "400607"),
                "tag": body.get("tag", "Home"),
                "latitude": body.get("latitude", 19.2183),
                "longitude": body.get("longitude", 72.9781)
            }
            if phone in SESSION_STATE["users"]:
                SESSION_STATE["users"][phone].setdefault("addresses", []).append(new_addr)
            return self._send_json({"status": True, "data": {"addressId": addr_id}})

        # 7. API: Order Checkout
        if path == "/api/cart/checkout" or path == "/api/cart/super/checkout":
            return self._handle_checkout(body)

        # 8. API: Initiate Payment
        if path == "/api/payment/v2/transaction/initiate":
            order_id = body.get("orderID", "DP1441_SAMPLE")
            pay_amount = body.get("payAmount", 500.0)
            txn_id = f"txn_{int(time.time())}"
            return self._send_json({
                "status": True,
                "data": {
                    "transactionId": txn_id,
                    "orderID": order_id,
                    "status": "INITIATED",
                    "amount": int(pay_amount * 100),
                    "key": "rzp_test_mock_1441",
                    "paymentUrl": f"/payment/processing/{txn_id}"
                }
            })

        # Default fallback
        return self._send_json({"status": True, "message": "OK"})

    def do_PUT(self):
        body = self._parse_json_body()
        return self._send_json({"status": True, "data": body})

    def _parse_json_body(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                raw_data = self.rfile.read(content_length).decode("utf-8")
                return json.loads(raw_data)
        except Exception:
            pass
        return {}

    def _handle_get_cstore(self, path, query):
        """Returns Store 6 (1441 Pizzeria - Thane) configuration."""
        data = {
            "status": True,
            "data": {
                "store": {
                    "storeId": 6,
                    "storeName": "1441 Pizzeria - Thane",
                    "merchantId": 1001,
                    "address": "Ground Floor, Viviana Mall, Eastern Express Hwy, Thane West",
                    "phone": "+919876543210",
                    "city": "Thane",
                    "lat": 19.2085,
                    "lng": 72.9715,
                    "isCorporate": False,
                    "storeServices": {
                        "delivery": True,
                        "pickup": True,
                        "instore": ["takeaway"]
                    },
                    "configs": {
                        "UITemplateData": {
                            "primaryColorCode": "#D32F2F",
                            "secondaryColorCode": "#212121",
                            "fontFamily": "Encode Sans"
                        },
                        "taxConfig": {
                            "gstPercentage": 5.0
                        },
                        "packagingCharges": 25.0
                    }
                },
                "merchant": {
                    "merchantId": 1001,
                    "merchantName": "1441 Pizzeria",
                    "logo": "https://cdn.dotpe.in/merchants/1441/logo.png"
                }
            }
        }
        return self._send_json(data)

    def _handle_get_menu(self, query):
        """Returns 1441 Pizzeria menu hierarchy."""
        data = {
            "status": True,
            "data": {
                "categories": CATEGORIES_DATA,
                "menuItems": MENU_ITEMS_DATA,
                "preorderFlags": {
                    "isPreorderEnabled": False
                }
            }
        }
        return self._send_json(data)

    def _handle_cart_sync(self, body):
        """Computes subtotal, GST (5%), packaging (₹25), delivery (₹40)."""
        items = body.get("items", [])
        item_total = 0.0
        total_qty = 0

        for it in items:
            qty = it.get("itemQty", 1)
            price = float(it.get("price", 0))
            item_total += price * qty
            total_qty += qty

        taxes = round(item_total * 0.05, 2)
        packaging = 25.0 if item_total > 0 else 0.0
        delivery = 40.0 if item_total > 0 else 0.0
        total_payable = round(item_total + taxes + packaging + delivery, 2)

        cart_id = body.get("cartID") or f"cart_1441_{int(time.time())}"
        cart_data = {
            "cartID": cart_id,
            "storeID": 6,
            "merchantID": 1001,
            "itemTotal": item_total,
            "taxes": taxes,
            "packagingCharges": packaging,
            "deliveryCharge": delivery,
            "discount": 0.0,
            "totalPayable": total_payable,
            "payAmount": total_payable,
            "remainingAmount": total_payable,
            "cartQuantity": total_qty,
            "items": items
        }
        SESSION_STATE["cart"][cart_id] = cart_data
        return self._send_json({"status": 200, "data": {"cart": cart_data, "status": True}})

    def _handle_checkout(self, body):
        """Creates order record and generates orderID and oHash."""
        order_num = int(time.time() % 100000)
        order_id = f"DP1441-{order_num}"
        o_hash = f"hash1441{order_num}xyz"

        items = body.get("items", [])
        item_total = sum(float(it.get("price", 0)) * it.get("itemQty", 1) for it in items)
        taxes = round(item_total * 0.05, 2)
        total_payable = round(item_total + taxes + 25.0 + 40.0, 2) if item_total > 0 else 0.0

        order_record = {
            "orderID": order_id,
            "oHash": o_hash,
            "orderStatus": "PREPARING",
            "paymentStatus": 3,
            "paymentMethod": "Razorpay UPI",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "deliveryTimeMinutes": 35,
            "items": items,
            "billingDetails": {
                "itemTotal": item_total,
                "taxes": taxes,
                "packaging": 25.0,
                "delivery": 40.0,
                "total": total_payable
            },
            "deliveryDetails": {
                "address": body.get("userInfo", {}).get("address", {}).get("address1", "Thane"),
                "customerPhone": body.get("phone", "9876543210")
            }
        }
        SESSION_STATE["orders"][o_hash] = order_record

        return self._send_json({
            "status": 200,
            "data": {
                "status": True,
                "orderID": order_id,
                "oHash": o_hash,
                "payAmount": total_payable,
                "remainingAmount": total_payable,
                "paymentMethods": ["razorpay", "simpl", "cod"]
            }
        })

    def _serve_index_html(self):
        """Serve index.html for SPA client-side routing."""
        index_file = os.path.join(BASE_DIR, "index.html")
        if not os.path.exists(index_file):
            self.send_error(404, "index.html not found")
            return

        with open(index_file, "rb") as f:
            content = f.read()

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def run_server():
    server_address = ("", PORT)
    httpd = http.server.HTTPServer(server_address, DotPeHandler)
    print("=" * 70)
    print(" 🍕 1441 Pizzeria - DotPe Offline Simulation Server")
    print("=" * 70)
    print(f" Loaded Catalog: {len(CATEGORIES_DATA)} Categories, {len(MENU_ITEMS_DATA)} Menu Items")
    print(f" Web Server Running at: http://localhost:{PORT}")
    print(f" Direct Storefront URL: http://localhost:{PORT}/store/6/delivery")
    print(f" Direct Cart URL:       http://localhost:{PORT}/cart")
    print("=" * 70)
    print("Press Ctrl+C to stop the server.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
