StockVelocity — standalone application update

Files: index.html, script.js
Keep your existing style.css unchanged. Place all three files in the same folder.

Changes:
- Removed external-platform runtime dependency and platform references.
- Preserved all page names, navigation, layouts, and form workflows.
- Corrected multi-location stock-map overwrites during shipping, receiving, production, and returns.
- Added guards against repeat return posting and repeat shipment.
- Added over-receipt validation.
- Added complete JSON backup and restore under Workspace settings.
- Storage save errors now propagate instead of silently showing a success.

LIMITATIONS:
- This version saves data only in the browser's localStorage, not on a server.
- It does not synchronize across devices or users. Browser cleanup can delete records.
- Back up regularly using Workspace settings.
- CSV exports are useful for reporting but do not replace the JSON backup.
- Client data and permissions need a secure backend before multi-user deployment.
- Stock updates and order statuses are not database transactions. Simultaneous-user accuracy requires backend transactions.
- Use a development copy and test with sample records before live operations.
