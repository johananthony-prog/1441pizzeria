#!/usr/bin/env python3
"""
La Pino'z Pizza & uEngage - Offline Simulation Server & API Mock
Reverse-Engineered Full-Stack Standalone Server
Port: 8084 (configurable)
"""

import http.server
import json
import mimetypes
import os
import re
import sys
import time
import urllib.parse
from http import HTTPStatus

DEFAULT_PORT = 8084
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FEED_PATH = os.path.join(BASE_DIR, "lapinoz_feed_6634.json")
if not os.path.exists(FEED_PATH):
    FEED_PATH = os.path.join(BASE_DIR, "feed", "v2", "feed_6634.json")

# Ensure MIME types are registered
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")

# 1x1 Transparent PNG for Captcha simulation
MOCK_CAPTCHA_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    b"\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)

# In-Memory Session State
SESSION_STATE = {
    "cart": {
        "items": [],
        "promoCode": None,
        "promoDiscount": 0.0,
        "walletApplied": 0.0,
        "addressId": "addr_101",
        "orderType": "1",  # 1: Delivery, 2: Pickup
    },
    "orders": {},
    "users": {
        "9876543210": {
            "contactId": "100982",
            "contactMappingId": "cm_887123",
            "name": "Guest Customer",
            "mobile": "9876543210",
            "token": "mock_jwt_token_lapinoz_thane_9912",
            "addresses": [
                {
                    "id": "addr_101",
                    "addressId": "addr_101",
                    "name": "Home",
                    "addressLine1": "Flat 402, Sunshine Heights",
                    "addressLine2": "Pokhran Road No. 1",
                    "locality": "Vartak Nagar",
                    "city": "Thane",
                    "pincode": "400606",
                    "latitude": "19.212791",
                    "longitude": "72.959877",
                    "addressType": "Home",
                    "isDefault": 1,
                }
            ],
            "wallet": {
                "balance": 150.0,
                "points": 150,
                "pts_unit": "LP Coins",
            },
        }
    },
}


def load_catalog_feed():
    """Loads and indexes the raw feed_6634.json menu data."""
    if not os.path.exists(FEED_PATH):
        print(f"[Warning] Menu feed not found at {FEED_PATH}")
        return {}, {}

    try:
        with open(FEED_PATH, "r", encoding="utf-8") as f:
            feed_raw = json.load(f)
    except Exception as e:
        print(f"[Error] Failed to read feed file: {e}")
        return {}, {}

    item_lookup = {}
    templates_lookup = {}

    # 1. Customization templates
    templates = feed_raw.get("rows", {}).get("templates", []) or []
    for t in templates:
        t_id = str(t.get("templateId", ""))
        item_lookup[t_id] = t
        for sub_item in t.get("items", []):
            s_id = str(sub_item.get("itemId", ""))
            item_lookup[s_id] = sub_item
            templates_lookup[s_id] = sub_item

    # 2. Menu Sections, Items, and Variants
    menu = feed_raw.get("rows", {}).get("menu", []) or []
    for sec in menu:
        for it in sec.get("items", []):
            i_id = str(it.get("id", ""))
            item_lookup[i_id] = it
            for v in it.get("variants", []):
                v_id = str(v.get("id", ""))
                item_lookup[v_id] = v
                for sv in v.get("variants", []):
                    sv_id = str(sv.get("id", ""))
                    item_lookup[sv_id] = sv

    print(f"[Init] Loaded feed from {FEED_PATH} ({len(menu)} sections, {len(item_lookup)} indexed entities)")
    return feed_raw, item_lookup


FEED_DATA, ITEM_LOOKUP = load_catalog_feed()


class LaPinozHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP Request Handler serving La Pino'z localized assets and mocking uEngage APIs."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _send_json(self, data, status_code=200):
        """Sends a JSON response with permissive CORS headers."""
        response_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Token, token, Accept, X-Requested-With")
        self.end_headers()
        self.wfile.write(response_bytes)

    def _send_bytes(self, content_bytes, content_type="application/octet-stream", status_code=200):
        """Sends raw bytes (images, stylesheets, scripts)."""
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content_bytes)

    def _serve_file(self, filename):
        """Serves an HTML file from BASE_DIR."""
        target_path = os.path.join(BASE_DIR, filename)
        if not os.path.exists(target_path):
            self.send_error(404, f"File {filename} not found")
            return
        with open(target_path, "rb") as f:
            content = f.read()
        self._send_bytes(content, "text/html; charset=utf-8")

    def do_OPTIONS(self):
        """Handles CORS preflight checks."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Token, token, Accept, X-Requested-With")
        self.end_headers()

    def do_HEAD(self):
        """Handle HEAD requests mirroring GET logic."""
        self.do_GET()

    def _parse_body(self):
        """Parses POST request body handling JSON, Form Data, and Multipart Form Data."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            return {}

        raw_bytes = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "")

        # 1. JSON
        if "application/json" in content_type:
            try:
                return json.loads(raw_bytes.decode("utf-8"))
            except Exception:
                return {}

        # 2. Multipart form data
        if "multipart/form-data" in content_type:
            boundary = None
            for part in content_type.split(";"):
                if "boundary=" in part:
                    boundary = part.split("boundary=")[1].strip().strip('"').strip("'")
                    break
            if boundary:
                result = {}
                delimiter = ("--" + boundary).encode("latin-1")
                chunks = raw_bytes.split(delimiter)
                for chunk in chunks:
                    if not chunk or chunk.startswith(b"--") or chunk == b"\r\n":
                        continue
                    parts = chunk.split(b"\r\n\r\n", 1)
                    if len(parts) < 2:
                        continue
                    header_part, body_part = parts
                    header_str = header_part.decode("latin-1", errors="ignore")
                    m = re.search(r'name="([^"]+)"', header_str)
                    if m:
                        name = m.group(1)
                        if body_part.endswith(b"\r\n"):
                            body_part = body_part[:-2]
                        result[name] = body_part.decode("utf-8", errors="ignore")
                return result

        # 3. URL-encoded
        try:
            parsed = urllib.parse.parse_qs(raw_bytes.decode("utf-8"))
            return {k: v[0] if len(v) == 1 else v for k, v in parsed.items()}
        except Exception:
            return {}

    # ─────────────────────────────────────────────────────────────
    # GET Request Dispatcher
    # ─────────────────────────────────────────────────────────────
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        query = urllib.parse.parse_qs(url.query)

        # 1. Menu Feed JSON
        if path.startswith("/feed/v2/feed_"):
            return self._send_json(FEED_DATA)

        # 2. Dietary & Tag Filter Definitions
        if path == "/client/getFilterList":
            return self._handle_get_filter_list()

        # 3. Time Slots
        if path.startswith("/client/getSlotsList"):
            return self._handle_get_slots()

        # 4. User LP Coins / Wallet Details
        if path == "/client/getWalletDetails":
            return self._handle_get_wallet_details(query)

        # 5. Saved User Addresses
        if path == "/client/getUserAddresses":
            return self._handle_get_user_addresses(query)

        # 6. Delivery Availability & Geocoding
        if path == "/client/checkDelivery":
            return self._send_json({"status": 1, "deliverable": 1, "msg": "Delivery available in Thane"})

        if path == "/maps/getGeocodeAddress":
            return self._send_json({
                "status": 1,
                "result": {
                    "formatted_address": "Vartak Nagar, Thane, Maharashtra 400606",
                    "locality": "Vartak Nagar",
                    "city": "Thane",
                    "pincode": "400606",
                    "lat": "19.212791",
                    "lng": "72.959877"
                }
            })

        # 7. Set Delivery Address
        if path == "/client/setDeliveryAddress":
            addr_id = query.get("addressId", ["addr_101"])[0]
            SESSION_STATE["cart"]["addressId"] = addr_id
            return self._send_json({"status": 1, "msg": "Delivery address set successfully"})

        # 8. Promo Code Application & Removal
        if path == "/client/applyPromo":
            return self._handle_apply_promo(query)

        if path == "/client/removePromo":
            SESSION_STATE["cart"]["promoCode"] = None
            SESSION_STATE["cart"]["promoDiscount"] = 0.0
            return self._recalculate_cart_response()

        # 9. Wallet (LP Coins) Application & Removal
        if path == "/client/applyWallet":
            pts = float(query.get("points", [50])[0])
            SESSION_STATE["cart"]["walletApplied"] = min(pts, 150.0)
            return self._recalculate_cart_response()

        if path == "/client/removeWallet":
            SESSION_STATE["cart"]["walletApplied"] = 0.0
            return self._recalculate_cart_response()

        # 10. Payment Initiation & Order Checkout
        if path in ("/pay/initiate/2.0/json", "/pay/initiate/json"):
            return self._handle_pay_initiate(query)

        # 11. Order Status Polling
        if path == "/client/getOrderStatus":
            return self._handle_get_order_status(query)

        # 12. uMoney / Wallet Payment Status
        if path == "/umoney/checkOrderPaymentStatus":
            return self._send_json({"status": 1, "paymentStatus": "success", "current_status": "1"})

        # 13. Active Orders
        if path == "/client/getActiveOrders":
            return self._handle_get_active_orders()

        # 14. Loyalty CRM Catalogs
        if path == "/crm_api/loyalty/item_wise/earn_burn_catalog":
            return self._send_json({
                "status": 1,
                "catalog": [
                    {"itemId": "1768168", "earn_points": 10, "burn_points": 50},
                    {"itemId": "46944453", "earn_points": 25, "burn_points": 100}
                ]
            })

        if path == "/crm_api/get/loyalty/rules/details":
            return self._send_json({"status": 1, "rules": {"cashback_percentage": 5, "min_order_value": 200}})

        # 15. Menu Global Search
        if path == "/search":
            return self._handle_search(query)

        # 16. Captcha Image
        if path == "/auth/captcha":
            return self._send_bytes(MOCK_CAPTCHA_PNG, "image/png")

        # 17. Page Routing
        if path.startswith("/order-polling"):
            return self._serve_file("order_polling.html")

        if path.startswith("/checkout"):
            return self._serve_file("checkout.html")

        if path == "/" or path.startswith("/order"):
            return self._serve_file("index.html")

        # 18. Local Static Files Fallback
        clean_path = path.lstrip("/")
        local_file = os.path.join(BASE_DIR, clean_path)
        if os.path.exists(local_file) and not os.path.isdir(local_file):
            return super().do_GET()

        # SPA Fallback to index.html
        return self._serve_file("index.html")

    # ─────────────────────────────────────────────────────────────
    # POST Request Dispatcher
    # ─────────────────────────────────────────────────────────────
    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        body = self._parse_body()

        # 1. Cart Synchronization Engine
        if path == "/client/cart":
            return self._handle_cart_sync(body)

        # 2. Authentication: Send OTP
        if path == "/auth/send-otp":
            phone = body.get("mobile", "9876543210")
            print(f"[Auth] Sent Mock OTP for {phone}: 1234")
            return self._send_json({"status": 1, "msg": "OTP sent successfully. Enter 1234 to log in."})

        # 3. Authentication: Verify OTP
        if path == "/auth/verify-otp":
            phone = body.get("mobile", "9876543210")
            otp = body.get("otp", "1234")
            user_data = {
                "token": f"mock_jwt_{phone}_{int(time.time())}",
                "contactId": "100982",
                "contactMappingId": "cm_887123",
                "mobile": phone,
                "name": "Guest Customer"
            }
            SESSION_STATE["users"][phone] = {
                **user_data,
                "addresses": SESSION_STATE["users"].get("9876543210", {}).get("addresses", []),
                "wallet": {"balance": 150.0, "points": 150, "pts_unit": "LP Coins"}
            }
            return self._send_json({
                "status": 1,
                "msg": "Login Successful",
                "rows": user_data,
                "result": user_data
            })

        # 4. Save User Address
        if path == "/client/saveUserAddress":
            new_id = f"addr_{int(time.time() % 1000)}"
            new_addr = {
                "id": new_id,
                "addressId": new_id,
                "name": body.get("name", "Home"),
                "addressLine1": body.get("addressLine1", "Flat 402, Sunshine Heights"),
                "addressLine2": body.get("addressLine2", "Pokhran Road No. 1"),
                "locality": body.get("locality", "Vartak Nagar"),
                "city": body.get("city", "Thane"),
                "pincode": body.get("pincode", "400606"),
                "latitude": body.get("latitude", "19.212791"),
                "longitude": body.get("longitude", "72.959877"),
                "addressType": body.get("addressType", "Home"),
                "isDefault": 1
            }
            SESSION_STATE["users"]["9876543210"]["addresses"].append(new_addr)
            SESSION_STATE["cart"]["addressId"] = new_id
            return self._send_json({"status": 1, "msg": "Address saved successfully", "result": {"addressId": new_id}})

        # 5. Pack Payment Status
        if path == "/PackageConfiguration/checkOrderPaymentStatus":
            return self._send_json({"status": 1, "current_status": "1"})

        # Fallback 404
        return self._send_json({"status": 0, "msg": f"Endpoint {path} not implemented"}, status_code=404)

    # ─────────────────────────────────────────────────────────────
    # API Implementation Handlers
    # ─────────────────────────────────────────────────────────────

    def _handle_get_filter_list(self):
        """Returns filter tags (dietary & popular badges)."""
        return self._send_json({
            "status": 1,
            "list": [
                {
                    "title": "Dietary",
                    "list": [
                        {"tagKey": "veg", "title": "Veg", "icon": "", "color": "#008000", "displayMode": "name", "is_usp": 0},
                        {"tagKey": "non-veg", "title": "Non-Veg", "icon": "", "color": "#b22222", "displayMode": "name", "is_usp": 0}
                    ]
                },
                {
                    "title": "Highlights",
                    "list": [
                        {"tagKey": "bestseller", "title": "Bestseller", "icon": "", "color": "#ff9900", "displayMode": "name", "is_usp": 0},
                        {"tagKey": "new", "title": "New", "icon": "", "color": "#0099ff", "displayMode": "name", "is_usp": 0}
                    ]
                }
            ]
        })

    def _handle_get_slots(self):
        """Returns delivery & pickup time slots."""
        today_str = time.strftime("%Y-%m-%d")
        return self._send_json({
            "status": 1,
            "result": [
                {
                    "date": today_str,
                    "label": "Today",
                    "slots": [
                        {"id": "1", "label": "Deliver Now (30 Mins)", "start_time": "10:00", "end_time": "23:00", "is_available": 1},
                        {"id": "2", "label": "08:00 PM - 09:00 PM", "start_time": "20:00", "end_time": "21:00", "is_available": 1},
                        {"id": "3", "label": "09:00 PM - 10:00 PM", "start_time": "21:00", "end_time": "22:00", "is_available": 1}
                    ]
                }
            ]
        })

    def _handle_get_wallet_details(self, query):
        """Returns user's LP Coins wallet balance."""
        user = SESSION_STATE["users"].get("9876543210", {})
        wallet = user.get("wallet", {"balance": 150.0, "points": 150, "pts_unit": "LP Coins"})
        return self._send_json({
            "status": 1,
            "result": {
                "balance": wallet["balance"],
                "points": wallet["points"],
                "currency": "₹",
                "pts_unit": wallet["pts_unit"],
                "title": "LP Coins Balance",
                "description": "Redeem up to 150 LP Coins on this order"
            }
        })

    def _handle_get_user_addresses(self, query):
        """Returns saved delivery addresses."""
        user = SESSION_STATE["users"].get("9876543210", {})
        addrs = user.get("addresses", [])
        return self._send_json({"status": 1, "result": addrs})

    def _handle_apply_promo(self, query):
        """Applies promo code to cart calculation."""
        code = query.get("promoCode", [""])[0].upper()
        if code in ("LAPINOZ50", "DISCOUNT50"):
            SESSION_STATE["cart"]["promoCode"] = code
            SESSION_STATE["cart"]["promoDiscount"] = 50.0
            return self._recalculate_cart_response(promo_msg="Coupon LAPINOZ50 applied! Flat ₹50 OFF.")
        elif code in ("WELCOME", "FIRST10"):
            SESSION_STATE["cart"]["promoCode"] = code
            SESSION_STATE["cart"]["promoDiscount"] = 35.0
            return self._recalculate_cart_response(promo_msg="Welcome Coupon applied! ₹35 OFF.")
        else:
            return self._send_json({"status": 0, "msg": f"Invalid or expired promo code '{code}'"})

    def _handle_search(self, query):
        """Searches indexed items in the catalog."""
        q = query.get("q", [""])[0].lower().strip()
        matched_items = []
        if q:
            for it_id, it in ITEM_LOOKUP.items():
                name = it.get("itemName", "")
                desc = it.get("description", "")
                if q in name.lower() or q in desc.lower():
                    matched_items.append({
                        "id": it_id,
                        "itemId": it_id,
                        "itemName": name,
                        "sectionName": "Sides" if "sides" in it.get("sectionName", "").lower() else "Menu",
                        "businessName": "La Pino'z Pizza",
                        "sp": it.get("sp", 0),
                        "mrp": it.get("mrp", 0),
                        "image": it.get("image", "")
                    })
                    if len(matched_items) >= 15:
                        break
        return self._send_json({
            "status": 1,
            "result": {
                "items": matched_items,
                "merchants": [{"id": 6634, "parentId": 5, "name": "La Pino'z Pizza"}]
            }
        })

    def _handle_cart_sync(self, body):
        """Processes cart modifications (add, delete, sync) and computes order breakdown."""
        action = body.get("action", "add")
        order_type = str(body.get("orderType", "1"))
        SESSION_STATE["cart"]["orderType"] = order_type

        # Handle 'delete' action
        if action == "delete":
            item_id_to_del = str(body.get("itemId", ""))
            current_items = SESSION_STATE["cart"]["items"]
            # Remove line matching orderItemId or itemId
            SESSION_STATE["cart"]["items"] = [
                it for it in current_items
                if str(it.get("orderItemId", "")) != item_id_to_del and str(it.get("itemId", "")) != item_id_to_del
            ]
            return self._recalculate_cart_response()

        # Handle 'add' action
        cart_raw = body.get("cart")
        if cart_raw:
            try:
                cart_obj = json.loads(cart_raw) if isinstance(cart_raw, str) else cart_raw
                new_items = cart_obj.get("items", [])
                if new_items:
                    # Append or replace lines in server state
                    for n_it in new_items:
                        i_id = str(n_it.get("itemId", ""))
                        qty = int(n_it.get("qty", 1))
                        subs = n_it.get("subItems", [])

                        # Find matching entry or add new
                        found = False
                        for existing in SESSION_STATE["cart"]["items"]:
                            if str(existing.get("itemId")) == i_id:
                                existing["qty"] = qty
                                existing["subItems"] = subs
                                found = True
                                break
                        if not found:
                            SESSION_STATE["cart"]["items"].append({
                                "orderItemId": f"oi_{int(time.time() * 1000) % 100000}_{len(SESSION_STATE['cart']['items']) + 1}",
                                "itemId": i_id,
                                "qty": qty,
                                "subItems": subs
                            })
            except Exception as e:
                print(f"[Cart] Error parsing incoming cart payload: {e}")

        return self._recalculate_cart_response()

    def _recalculate_cart_response(self, promo_msg=None):
        """Calculates item totals, taxes, packaging, delivery fee, and returns standard uEngage payload."""
        cart_state = SESSION_STATE["cart"]
        lines = []
        subtotal = 0.0

        for idx, entry in enumerate(cart_state["items"]):
            i_id = str(entry.get("itemId", ""))
            qty = max(1, int(entry.get("qty", 1)))
            sub_items_in = entry.get("subItems", [])

            # Item details from catalog
            cat_item = ITEM_LOOKUP.get(i_id, {})
            base_name = cat_item.get("itemName", f"Item #{i_id}")
            base_price = float(cat_item.get("sp", 0) or cat_item.get("price", 0) or 0)
            is_veg = cat_item.get("vegNonvegBoth", "veg")

            # Customizations / SubItems
            resolved_subs = []
            addon_price_sum = 0.0

            if isinstance(sub_items_in, dict):
                sub_items_in = list(sub_items_in.values())

            for s in sub_items_in:
                s_id = str(s.get("itemId", ""))
                s_qty = int(s.get("qty", 1))
                s_cat = ITEM_LOOKUP.get(s_id, {})
                s_name = s.get("itemName") or s_cat.get("itemName", f"Option #{s_id}")
                s_price = float(s.get("price", 0) or s.get("sp", 0) or s_cat.get("sp", 0) or 0)
                addon_price_sum += s_price * s_qty
                resolved_subs.append({
                    "itemId": s_id,
                    "itemName": s_name,
                    "sp": s_price,
                    "price": s_price,
                    "subTotal": s_price * s_qty,
                    "qty": s_qty,
                })

            effective_unit_price = base_price + addon_price_sum
            line_subtotal = effective_unit_price * qty
            subtotal += line_subtotal

            order_item_id = entry.get("orderItemId") or f"oi_{idx + 1}"
            entry["orderItemId"] = order_item_id

            lines.append({
                "orderItemId": order_item_id,
                "itemId": i_id,
                "parentId": str(cat_item.get("parentId", i_id)),
                "itemName": base_name,
                "price": str(base_price),
                "subTotal": line_subtotal,
                "qty": qty,
                "veg": is_veg,
                "itemSaleType": "delivery",
                "validateStatus": 1,
                "subItems": resolved_subs
            })

        # Charges & Taxes
        is_delivery = cart_state.get("orderType", "1") == "1"
        delivery_charge = 40.0 if (is_delivery and subtotal > 0) else 0.0
        packaging_charge = 30.0 if subtotal > 0 else 0.0
        tax_rate = 0.05  # 5% GST
        taxes = round(subtotal * tax_rate, 2)
        half_tax = round(taxes / 2.0, 2)

        discount = float(cart_state.get("promoDiscount", 0.0))
        wallet = float(cart_state.get("walletApplied", 0.0))

        grand_total = max(0.0, round(subtotal + packaging_charge + delivery_charge + taxes - discount - wallet, 2))

        # Order Details Record
        order_record = {
            "orderId": "66349912",
            "businessId": "6634",
            "subTotal": round(subtotal, 2),
            "taxes": taxes,
            "taxBreakUp": [
                {"name": "CGST", "tax": 2.5, "amount": half_tax},
                {"name": "SGST", "tax": 2.5, "amount": half_tax}
            ],
            "packaging_charges": packaging_charge,
            "packagingCharge": packaging_charge,
            "deliveryCharges": delivery_charge,
            "serviceCharges": 0.0,
            "discount": discount,
            "wallet_amount": wallet,
            "totalAmt": grand_total,
            "grandTotal": grand_total,
            "promoCodeId": 1 if cart_state.get("promoCode") else 0,
            "promoCode": cart_state.get("promoCode", ""),
            "code": cart_state.get("promoCode", ""),
            "deliveryAddressId": cart_state.get("addressId", "addr_101"),
            "addressLine1": "Flat 402, Sunshine Heights",
            "addressLine2": "Pokhran Road No. 1",
            "locality": "Vartak Nagar",
            "city": "Thane",
            "pincode": "400606",
            "name": "Home",
            "orderType": int(cart_state.get("orderType", "1")),
            "slotsDetails": [
                {
                    "date": time.strftime("%Y-%m-%d"),
                    "slots": [
                        {"id": "1", "label": "Deliver Now (30 Mins)", "start_time": "10:00", "end_time": "23:00"}
                    ]
                }
            ]
        }

        response_payload = {
            "status": 1,
            "msg": promo_msg or "Cart synchronized successfully",
            "result": {
                "rows": {
                    "orderDetails": [order_record],
                    "orderItemDetails": lines,
                    "subTotal": round(subtotal, 2),
                    "totalTax": taxes,
                    "packagingCharge": packaging_charge,
                    "deliveryCharges": delivery_charge,
                    "discount": discount,
                    "grandTotal": grand_total,
                    "totalAmt": grand_total,
                    "promoCodes": [
                        {"code": "LAPINOZ50", "discount": 50, "description": "Flat ₹50 OFF on orders above ₹199"},
                        {"code": "WELCOME", "discount_pct": 10, "description": "10% OFF on your order"}
                    ],
                    "suggestions": [],
                    "validation": {"status": 1, "message": "Cart is valid and serviceable"}
                }
            }
        }
        return self._send_json(response_payload)

    def _handle_pay_initiate(self, query):
        """Creates order and returns payment parameters or mock direct redirect."""
        order_id = f"6634{int(time.time() % 100000):05d}"
        cart_state = SESSION_STATE["cart"]
        subtotal = sum(
            float(ITEM_LOOKUP.get(str(it.get("itemId")), {}).get("sp", 0) or 150) * int(it.get("qty", 1))
            for it in cart_state["items"]
        )
        total_amt = max(0.0, round(subtotal + 30.0 + (40.0 if cart_state.get("orderType") == "1" else 0) + round(subtotal * 0.05, 2) - cart_state.get("promoDiscount", 0) - cart_state.get("walletApplied", 0), 2))

        # Store created order in SESSION_STATE
        SESSION_STATE["orders"][order_id] = {
            "order_id": order_id,
            "current_status": "1",
            "payment_status": "1",
            "order_amount": total_amt,
            "kitchen_status": "PREPARING",
            "created_at": time.time(),
        }

        # Clear cart upon order placement
        SESSION_STATE["cart"]["items"] = []

        return self._send_json({
            "status": 1,
            "msg": "Order initiated successfully",
            "orderId": order_id,
            "payment_gateway_direct": 0,
            "redirect": f"/order-polling/{order_id}",
            "razorpay": {
                "key": "rzp_test_lapinoz_mock_platform",
                "amount": int(total_amt * 100),
                "currency": "INR",
                "name": "La Pino'z Pizza",
                "order_id": f"order_rzp_{order_id}",
                "callback_url": f"/order-polling/{order_id}"
            }
        })

    def _handle_get_order_status(self, query):
        """Simulates live order lifecycle progression (Received -> Preparing -> Dispatched)."""
        order_id = query.get("orderId", ["66349912"])[0]
        order = SESSION_STATE["orders"].get(order_id)
        if not order:
            order = {
                "order_id": order_id,
                "current_status": "1",
                "payment_status": "1",
                "order_amount": 340.9,
                "kitchen_status": "PREPARING",
                "created_at": time.time(),
            }
            SESSION_STATE["orders"][order_id] = order

        # Progress lifecycle based on elapsed seconds
        elapsed = time.time() - order.get("created_at", time.time())
        if elapsed > 45:
            current_status = "4"  # Dispatched with Rider
            kitchen_status = "OUT_FOR_DELIVERY"
        elif elapsed > 20:
            current_status = "3"  # Food Prepared
            kitchen_status = "READY_FOR_PICKUP"
        elif elapsed > 10:
            current_status = "2"  # Confirmed by Kitchen
            kitchen_status = "PREPARING"
        else:
            current_status = "1"  # Received
            kitchen_status = "RECEIVED"

        return self._send_json({
            "status": 1,
            "result": {
                "order_id": order_id,
                "current_status": current_status,
                "payment_status": "1",
                "order_amount": order.get("order_amount", 340.9),
                "kitchen_status": kitchen_status,
                "eta": "25-30 Mins",
                "rider": {
                    "name": "Ramesh Kumar",
                    "phone": "9876543210",
                    "vehicle": "MH04-AB-1234"
                }
            }
        })

    def _handle_get_active_orders(self):
        """Returns recent active orders for the profile sidebar."""
        user = SESSION_STATE["users"].get("9876543210", {})
        active_list = []
        for o_id, o in SESSION_STATE["orders"].items():
            active_list.append({
                "orderId": o_id,
                "businessId": "6634",
                "brandName": "La Pino'z Pizza",
                "orderAmount": o.get("order_amount", 340.9),
                "orderStatus": o.get("kitchen_status", "PREPARING"),
                "currentStatus": o.get("current_status", "1"),
                "date": time.strftime("%d %b %Y, %I:%M %p")
            })
        return self._send_json({"status": 1, "active_orders": active_list})


def run_server(port=DEFAULT_PORT):
    """Starts the simulation server on the designated port."""
    server_address = ("", port)
    try:
        httpd = http.server.HTTPServer(server_address, LaPinozHandler)
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"[Notice] Port {port} in use, trying port {port + 1}...")
            return run_server(port + 1)
        raise e

    print("=" * 70)
    print("🍕  LA PINO'Z PIZZA & uENGAGE - STANDALONE SIMULATION SERVER  🍕")
    print("=" * 70)
    print(f"Server running at:  http://localhost:{port}/")
    print(f"Storefront Sides:  http://localhost:{port}/order/lapinoz-vartak-nagar-thane?section_slug=sides")
    print(f"Checkout URL:      http://localhost:{port}/checkout/6634/1")
    print(f"Order Tracking:    http://localhost:{port}/order-polling/66349912")
    print("-" * 70)
    print("Press Ctrl+C to terminate.")
    print("=" * 70)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Shutdown] Server stopped by user.")
        httpd.server_close()


if __name__ == "__main__":
    cli_port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    run_server(cli_port)
