# Virus Scanning Integration (Optional for Production)

## Overview
This application supports optional virus scanning of uploaded files using ClamAV.

## Installation

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install clamav clamav-daemon
sudo freshclam  # Update virus definitions
sudo systemctl start clamav-daemon
sudo systemctl enable clamav-daemon
```

### macOS
```bash
brew install clamav
freshclam  # Update virus definitions
# Start daemon
clamd
```

### Windows
1. Download ClamAV from https://www.clamav.net/downloads
2. Install and configure clamd
3. Update virus definitions

## Python Package
```bash
pip install pyclamd
```

## Configuration

Add to your `.env` file:
```
ENABLE_VIRUS_SCAN=true
```

## Usage

### In Upload Routes
Replace standard `validate_upload` with virus-scanning version:

```python
from app.utils.virus_scan import validate_upload_with_virus_scan

# In upload handler
try:
    validate_upload_with_virus_scan(file, user_id=current_user.id)
except ValueError as e:
    return jsonify({'error': str(e)}), 400
```

### Check Scanning Status
```python
from app.utils.virus_scan import get_scan_status

status = get_scan_status()
print(status)
```

## Testing

Test with EICAR test virus file:
```bash
# Download EICAR test file (harmless test virus)
curl -o eicar.com https://secure.eicar.org/eicar.com

# Try to upload - should be rejected
```

## Monitoring

All virus detections are logged with `[VIRUS_DETECTED]` prefix:
- Check application logs for virus alerts
- Infected files are automatically deleted
- User is notified that file was rejected

## Production Recommendations

1. **Always enable** virus scanning in production
2. Keep ClamAV definitions updated (run `freshclam` daily via cron)
3. Monitor logs for virus detection patterns
4. Alert administrators on virus detection
5. Consider additional scanning at network perimeter

## Troubleshooting

### ClamAV Daemon Not Running
```bash
sudo systemctl status clamav-daemon
sudo systemctl start clamav-daemon
```

### Connection Failed
Check socket path in pyclamd configuration:
```python
import pyclamd
cd = pyclamd.ClamdUnixSocket('/var/run/clamav/clamd.ctl')
```

### High Memory Usage
ClamAV can use significant memory. For production:
- Allocate at least 2GB RAM for ClamAV
- Consider using ClamAV in a separate container/service
- Use `scan_stream` for large files instead of loading entire file

## Security Notes

- Virus scanning is **complementary** to magic number validation
- Never rely on virus scanning alone
- Keep virus definitions updated
- Infected files are deleted immediately upon detection
- All detections are logged for audit trail
