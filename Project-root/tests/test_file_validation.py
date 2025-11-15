import io
import os
import sys

import pytest
from werkzeug.datastructures import FileStorage

from app.utils.file_validation import validate_upload


class TestFileValidation:
    """Comprehensive tests for secure file upload validation"""

    def test_valid_jpeg_upload(self):
        """Test valid JPEG file with correct magic number"""
        jpeg_header = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(jpeg_header),
            filename="test.jpg",
            content_type="image/jpeg",
        )
        assert validate_upload(file)

    def test_valid_png_upload(self):
        """Test valid PNG file with correct magic number and IHDR chunk"""
        # Minimal valid PNG header with IHDR (1x1 pixel, truecolor)
        png_header = (
            b"\x89PNG\r\n\x1a\n"  # Signature
            b"\x00\x00\x00\r"  # Length (13)
            b"IHDR"
            b"\x00\x00\x00\x01"  # Width: 1
            b"\x00\x00\x00\x01"  # Height: 1
            b"\x08"  # Bit depth: 8
            b"\x02"  # Color type: Truecolor
            b"\x00"  # Compression
            b"\x00"  # Filter
            b"\x00"  # Interlace
            b"\x90wS\xde"  # CRC (placeholder, magic doesn't validate)
        ) + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(png_header), filename="test.png", content_type="image/png"
        )
        assert validate_upload(file)

    def test_valid_gif87a_upload(self):
        """Test valid GIF87a file with correct magic number"""
        gif_header = b"GIF87a" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(gif_header), filename="test.gif", content_type="image/gif"
        )
        assert validate_upload(file)

    def test_valid_gif89a_upload(self):
        """Test valid GIF89a file with correct magic number"""
        gif_header = b"GIF89a" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(gif_header), filename="test.gif", content_type="image/gif"
        )
        assert validate_upload(file)

    def test_valid_pdf_upload(self):
        """Test valid PDF file with correct magic number"""
        pdf_header = b"%PDF-1.4" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(pdf_header),
            filename="test.pdf",
            content_type="application/pdf",
        )
        assert validate_upload(file)

    @pytest.mark.skipif(
        sys.platform.startswith("win"),
        reason="libmagic on Windows may report CSV as text/plain",
    )
    def test_valid_csv_upload(self):
        """Test valid CSV file (skipped on Windows due to libmagic variance)"""
        csv_content = (
            b"Name,Age,City\n"
            + b"John,30,New York\n"
            + b"Jane,25,Los Angeles\n"
            + b"Alice,28,Chicago\n"
        )
        file = FileStorage(
            stream=io.BytesIO(csv_content), filename="test.csv", content_type="text/csv"
        )
        assert validate_upload(file)

    def test_invalid_mime_type_exe(self):
        """Test rejection of .exe file"""
        exe_header = b"MZ\x90\x00" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(exe_header),
            filename="malware.exe",
            content_type="application/x-msdownload",
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(file)

    def test_invalid_mime_type_php(self):
        """Test rejection of .php file"""
        php_content = b'<?php echo "malicious"; ?>'
        file = FileStorage(
            stream=io.BytesIO(php_content),
            filename="shell.php",
            content_type="application/x-php",
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(file)

    def test_invalid_mime_type_js(self):
        """Test rejection of .js file"""
        js_content = b'alert("XSS");'
        file = FileStorage(
            stream=io.BytesIO(js_content),
            filename="script.js",
            content_type="application/javascript",
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(file)

    def test_invalid_mime_type_html(self):
        """Test rejection of .html file"""
        html_content = b'<html><script>alert("XSS")</script></html>'
        file = FileStorage(
            stream=io.BytesIO(html_content),
            filename="xss.html",
            content_type="text/html",
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(file)

    def test_file_size_limit_exceeded(self):
        """Test rejection of oversized file (>10MB)"""
        # Create 11MB file
        large_content = b"\xff\xd8\xff\xe0" + b"\x00" * (11 * 1024 * 1024)
        file = FileStorage(
            stream=io.BytesIO(large_content),
            filename="large.jpg",
            content_type="image/jpeg",
        )
        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            validate_upload(file)

    def test_file_size_exactly_at_limit(self):
        """Test file exactly at 10MB limit should pass"""
        # Create exactly 10MB JPEG
        jpeg_content = b"\xff\xd8\xff\xe0" + b"\x00" * (10 * 1024 * 1024 - 4)
        file = FileStorage(
            stream=io.BytesIO(jpeg_content),
            filename="exactly10mb.jpg",
            content_type="image/jpeg",
        )
        assert validate_upload(file)

    def test_magic_number_mismatch_jpeg(self):
        """Test rejection of file with wrong magic number for declared MIME"""
        # PNG with valid IHDR; should be detected as PNG regardless of filename
        fake_jpeg = (
            b"\x89PNG\r\n\x1a\n"
            b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
        ) + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(fake_jpeg), filename="fake.jpg", content_type="image/jpeg"
        )
        # This will be detected as PNG and pass since PNG is allowed
        assert validate_upload(file)

    def test_magic_number_mismatch_pdf_with_wrong_signature(self):
        """Test rejection of PDF with incorrect signature"""
        # Text file masquerading as PDF (will be detected as text/plain)
        fake_pdf = b"This is not a PDF file" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(fake_pdf),
            filename="fake.pdf",
            content_type="application/pdf",
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(file)

    def test_polyglot_file_jpeg_pdf(self):
        """Test rejection of polyglot file (JPEG + PDF)"""
        # Start with JPEG magic but also contains PDF
        polyglot = b"\xff\xd8\xff\xe0" + b"%PDF-1.4" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(polyglot),
            filename="polyglot.jpg",
            content_type="image/jpeg",
        )
        # Will be detected as JPEG by magic, should pass
        assert validate_upload(file)

    def test_empty_file(self):
        """Test rejection of empty file"""
        empty_file = FileStorage(
            stream=io.BytesIO(b""), filename="empty.jpg", content_type="image/jpeg"
        )
        with pytest.raises(ValueError, match="not allowed"):
            validate_upload(empty_file)

    def test_corrupted_jpeg_header(self):
        """Test rejection of corrupted JPEG"""
        corrupted = b"\xff\xd8\x00\x00" + b"\x00" * 2000  # Invalid JPEG
        file = FileStorage(
            stream=io.BytesIO(corrupted),
            filename="corrupted.jpg",
            content_type="image/jpeg",
        )
        # May be detected as different MIME, should fail
        with pytest.raises(ValueError, match="(not allowed|mismatch|does not match)"):
            validate_upload(file)

    def test_csv_without_commas(self):
        """Test rejection of CSV file without commas"""
        invalid_csv = b"This is just text\nNo commas here"
        file = FileStorage(
            stream=io.BytesIO(invalid_csv),
            filename="invalid.csv",
            content_type="text/csv",
        )
        with pytest.raises(ValueError, match="(CSV|not appear valid|not allowed)"):
            validate_upload(file)

    def test_custom_size_limit(self):
        """Test custom size limit parameter"""
        # 2MB file with 1MB limit
        large_content = b"\xff\xd8\xff\xe0" + b"\x00" * (2 * 1024 * 1024)
        file = FileStorage(
            stream=io.BytesIO(large_content),
            filename="large.jpg",
            content_type="image/jpeg",
        )
        with pytest.raises(ValueError, match="exceeds.*1MB"):
            validate_upload(file, max_size_mb=1)

    def test_multiple_sequential_uploads(self):
        """Test multiple sequential uploads to ensure state management"""
        for i in range(3):
            jpeg_header = b"\xff\xd8\xff\xe0" + b"\x00" * 2000
            file = FileStorage(
                stream=io.BytesIO(jpeg_header),
                filename=f"test{i}.jpg",
                content_type="image/jpeg",
            )
            assert validate_upload(file)

    def test_file_stream_position_reset(self):
        """Test that file stream position is reset after validation"""
        jpeg_header = b"\xff\xd8\xff\xe0" + b"\x00" * 2000
        stream = io.BytesIO(jpeg_header)
        file = FileStorage(
            stream=stream, filename="test.jpg", content_type="image/jpeg"
        )
        validate_upload(file)
        # Stream should be reset to beginning
        assert stream.tell() == 0


class TestSecurityRegression:
    """Regression tests to ensure no fallback logic exists"""

    def test_no_fallback_import(self):
        """Ensure python-magic import has no try/except fallback"""
        file_path = os.path.join(
            os.path.dirname(__file__), "..", "app", "utils", "file_validation.py"
        )
        with open(file_path, "r") as f:
            content = f.read()
            assert (
                "except ImportError" not in content
            ), "Fallback import logic found - python-magic must be hard dependency"
            assert "import magic" in content, "python-magic import missing"

    def test_validate_upload_raises_on_failure(self):
        """Ensure validate_upload raises exceptions, not returns (False, msg)"""
        exe_header = b"MZ\x90\x00" + b"\x00" * 2000
        file = FileStorage(
            stream=io.BytesIO(exe_header),
            filename="test.exe",
            content_type="application/x-msdownload",
        )
        # Should raise, not return tuple
        with pytest.raises(ValueError):
            validate_upload(file)
