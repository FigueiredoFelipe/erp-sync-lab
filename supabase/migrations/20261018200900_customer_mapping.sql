-- Customer mapping (SPEC BR05, R05; PLAN "Customer resolution"). Config reviewed like code: every change is
-- a new migration that calls internal.apply_customer_mapping with the complete mapping; the latest one wins.
-- Every canonical customer is listed, including those in only one source.
--   erpnext:       ERPNext customer IDs (the customer name in this instance), matched exactly.
--   legacy_unit_b: Unit B names as written in the export (data/legacy_unit_b.README.md); the consumer matches
--                  them after normalization (case, punctuation, spaces), legal suffixes kept.
-- Kept last in this batch of migrations so it runs after the functions it calls and enqueues through.

select internal.apply_customer_mapping($mapping$
[
  { "canonical_id": "blue-ridge-kitchens", "display_name": "Blue Ridge Kitchens",
    "erpnext": ["Blue Ridge Kitchens"], "legacy_unit_b": ["Blue Ridge Kitchens LLC"] },
  { "canonical_id": "harbor-lane-bistro", "display_name": "Harbor Lane Bistro",
    "erpnext": ["Harbor Lane Bistro"], "legacy_unit_b": ["Harbor Ln. Bistro"] },
  { "canonical_id": "golden-spoon-catering", "display_name": "Golden Spoon Catering",
    "erpnext": ["Golden Spoon Catering"], "legacy_unit_b": [] },
  { "canonical_id": "prairie-fork-restaurant-group", "display_name": "Prairie Fork Restaurant Group",
    "erpnext": ["Prairie Fork Restaurant Group"], "legacy_unit_b": [] },
  { "canonical_id": "copper-kettle-diner", "display_name": "Copper Kettle Diner",
    "erpnext": ["Copper Kettle Diner"], "legacy_unit_b": [] },
  { "canonical_id": "maple-street-cafe", "display_name": "Maple Street Cafe",
    "erpnext": ["Maple Street Cafe"], "legacy_unit_b": [] },
  { "canonical_id": "sunset-grill-taphouse", "display_name": "Sunset Grill & Taphouse",
    "erpnext": ["Sunset Grill & Taphouse"], "legacy_unit_b": ["SUNSET GRILL AND TAPHOUSE"] },
  { "canonical_id": "riverbend-hospitality", "display_name": "Riverbend Hospitality",
    "erpnext": ["Riverbend Hospitality"], "legacy_unit_b": [] },
  { "canonical_id": "acme-foods", "display_name": "Acme Foods Inc.",
    "erpnext": ["Acme Foods Inc."], "legacy_unit_b": ["ACME FOODS"] },
  { "canonical_id": "lakeside-deli-co", "display_name": "Lakeside Deli Co.",
    "erpnext": ["Lakeside Deli Co."], "legacy_unit_b": ["Lakeside Deli Company"] },
  { "canonical_id": "northgate-school-cafeteria-services", "display_name": "Northgate School Cafeteria Services",
    "erpnext": ["Northgate School Cafeteria Services"], "legacy_unit_b": [] },
  { "canonical_id": "redwood-pizza-kitchen", "display_name": "Redwood Pizza Kitchen",
    "erpnext": ["Redwood Pizza Kitchen"], "legacy_unit_b": ["REDWOOD  PIZZA KITCHEN"] },
  { "canonical_id": "union-station-eatery", "display_name": "Union Station Eatery",
    "erpnext": ["Union Station Eatery"], "legacy_unit_b": [] },
  { "canonical_id": "bayview-noodle-house", "display_name": "Bayview Noodle House",
    "erpnext": ["Bayview Noodle House"], "legacy_unit_b": [] },
  { "canonical_id": "elm-oak-supper-club", "display_name": "Elm & Oak Supper Club",
    "erpnext": ["Elm & Oak Supper Club"], "legacy_unit_b": [] },
  { "canonical_id": "cedar-valley-bakery", "display_name": "Cedar Valley Bakery, Inc.",
    "erpnext": [], "legacy_unit_b": ["Cedar Valley Bakery, Inc."] },
  { "canonical_id": "old-mill-tavern", "display_name": "Old Mill Tavern",
    "erpnext": [], "legacy_unit_b": ["Old Mill Tavern"] },
  { "canonical_id": "pinecrest-senior-living", "display_name": "Pinecrest Senior Living",
    "erpnext": [], "legacy_unit_b": ["Pinecrest Senior Living"] }
]
$mapping$::jsonb);
