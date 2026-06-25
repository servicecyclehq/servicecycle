# Parts & Spare Inventory

The Parts catalog tracks every spare part your facility stocks and links each part
to the equipment that needs it. The result is a real-time picture of what is on
hand, what is running low, and which assets are at risk if a part goes out of stock.

## What you'll see

**The parts list** is your account-wide catalog. Each row shows a part number,
description, manufacturer, category (breaker, transformer, relay, fuse, etc.),
unit cost, and typical lead time in weeks. Use the search bar to filter by name,
part number, or category.

**The inventory panel** below each part shows where that part is stocked: by site,
by asset, or floating at the account level — and the quantity on hand versus the
configured minimum. Any location below its minimum shows an amber LOW badge; out
of stock shows a red OOS badge.

**The dashboard card** surfaces the account-wide risk picture: how many locations
are low, which carry no minimum at all (unmanaged), and which are completely out
of stock.

**The Required Parts panel on AssetDetail** lists every part the asset depends on,
with an OK / LOW / OOS badge so a technician can confirm stock before dispatching
a work order.

## Key concepts

**Part** is the catalog entry — the what. It does not carry a quantity; quantity
lives in the inventory record.

**SpareInventory** is a quantity-at-location record — how many of that part are on
hand at a specific site, asset bay, or account float. One part can have inventory
records at many locations simultaneously.

**Minimum quantity** is the reorder threshold. Setting a minimum turns on
low-stock monitoring for that location. Leaving it null means you acknowledge you
have no formal minimum; that location won't fire alerts but also won't appear
"healthy."

**Lead time (weeks)** on a part record is how long a typical procurement takes.
Combined with a low-stock alert, it tells you whether you have time to reorder
before the next maintenance window.

## Common workflows

**"Add a part to the catalog."** Sidebar → Parts → +. Fill in the part number,
description, and category. Lead time and unit cost are optional but recommended
for procurement risk.

**"Record inventory at a location."** Open the part → Inventory tab → Add
location. Choose site and/or asset, enter qty on hand, set a minimum if you want
alerts.

**"Import the catalog from a spreadsheet."** Use the CSV import button on the
Parts list. Download the template, fill it in, and upload. Existing part numbers
are updated; new ones are created.

**"Link a part to an asset as required."** Open the asset → Required Parts tab →
Add part. Set how many units a single maintenance event needs.

**"See everything that is low or out of stock right now."** Dashboard → Parts
Alerts card, or filter the Parts list by LOW / OOS status.

## When something looks wrong

**A part shows OOS but we definitely have stock.** The inventory record exists but
the qty on hand was not updated after the last receipt. Open the inventory line
and correct the qty.

**The Required Parts panel on an asset shows LOW or OOS.** Stock at the linked
locations is below the minimum or zero. Reorder or move stock from a float
location before scheduling the next work order on that asset.

**CSV import failed.** Check that the part number column is present and that
numeric columns (qty, lead time, unit cost) contain numbers, not formatted text
like "2 weeks". Download a fresh template if the column layout has changed.
