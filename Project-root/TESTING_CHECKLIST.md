# MTC Application Testing Checklist

## Security Tests
- [ ] Try uploading .php file → Should be rejected
- [ ] Try SQL injection in item name: `'; DROP TABLE users; --` → Should be safely escaped
- [ ] Try logging in 6 times quickly → Should hit rate limit
- [ ] Check .env file not in git: `git status`
- [ ] Sign up with weak password "12345" → Should be rejected
- [ ] Inspect HTTPS redirect (production only)

## Functionality Tests
- [ ] Add new item with image → Should save successfully
- [ ] Edit existing item → Should update without errors
- [ ] Delete item → Should remove from database
- [ ] Add variant to item → Should appear in matrix
- [ ] Update stock in variant matrix → Should update immediately
- [ ] Search for items → Should filter correctly with 300ms debounce
- [ ] Filter low stock items → Should show only low stock
- [ ] Import CSV data → Modal should open and preview correctly
- [ ] Create purchase order → Should save all items
- [ ] Add supplier with contacts → Should save all contacts

## Performance Tests
- [ ] Load inventory page with 100+ items → Should load in < 2 seconds
- [ ] Search rapidly → Should not lag (debounced)
- [ ] Open/close modals 10 times → No memory increase in DevTools
- [ ] Update stock 20 times quickly → Should handle smoothly

## Database Tests
- [ ] Run migrations → All indexes created successfully
- [ ] Check connection pool → Should show 2-20 connections in logs
- [ ] Query item_variant → Should use idx_item_variant_stock index

## Browser Compatibility
- [ ] Chrome/Edge → All features work
- [ ] Firefox → All features work
- [ ] Safari → All features work
- [ ] Mobile responsive → Table scrolls horizontally on small screens

## Error Handling
- [ ] Disconnect database → Should show connection error (not crash)
- [ ] Submit form with missing fields → Should show validation errors
- [ ] Network error during API call → Should show notification
- [ ] Upload file larger than 5MB → Should reject with message
