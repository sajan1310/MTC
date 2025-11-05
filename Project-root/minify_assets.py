import os
import re


def minify_js(content):
    # Remove single-line comments
    content = re.sub(r"//.*", "", content)
    # Remove multi-line comments
    content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    # Remove leading/trailing whitespace from lines
    content = "\n".join(line.strip() for line in content.splitlines())
    # Remove blank lines
    content = re.sub(r"\n\s*\n", "\n", content)
    return content


def minify_css(content):
    # Remove comments
    content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    # Remove whitespace around selectors, braces, and properties
    content = re.sub(r"\s*([\{\}:;,])\s*", r"\1", content)
    # Remove trailing semicolons in a block
    content = re.sub(r";\}", "}", content)
    # Remove blank lines
    content = re.sub(r"^\s*$", "", content, flags=re.MULTILINE)
    return content


def main():
    static_folder = os.path.join(os.path.dirname(__file__), "static")

    # Minify JS (skip if file doesn't exist)
    js_path = os.path.join(static_folder, "app.js")
    min_js_path = os.path.join(static_folder, "app.min.js")
    if os.path.exists(js_path):
        print(f"Reading {js_path}...")
        with open(js_path, "r", encoding="utf-8") as f:
            js_content = f.read()

        minified_js = minify_js(js_content)

        with open(min_js_path, "w", encoding="utf-8") as f:
            f.write(minified_js)
        print(f"Successfully created {min_js_path}")
    else:
        print(f"Skipping {js_path} (file not found)")

    # Minify CSS
    css_path = os.path.join(static_folder, "styles.css")
    min_css_path = os.path.join(static_folder, "styles.min.css")
    print(f"Reading {css_path}...")
    with open(css_path, "r", encoding="utf-8") as f:
        css_content = f.read()

    minified_css = minify_css(css_content)

    with open(min_css_path, "w", encoding="utf-8") as f:
        f.write(minified_css)
    print(f"Successfully created {min_css_path}")


if __name__ == "__main__":
    main()
