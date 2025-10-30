import os

def generate_structure(directory, output_file, ignore_list=None):
    if ignore_list is None:
        ignore_list = []
    
    with open(output_file, 'w') as f:
        for root, dirs, files in os.walk(directory):
            # Ignore specified directories
            dirs[:] = [d for d in dirs if d not in ignore_list]
            
            level = root.replace(directory, '').count(os.sep)
            indent = ' ' * 4 * (level)
            f.write('{}{}/\n'.format(indent, os.path.basename(root)))
            sub_indent = ' ' * 4 * (level + 1)
            for file in files:
                f.write('{}{}\n'.format(sub_indent, file))

if __name__ == '__main__':
    project_directory = '.'
    output_filename = 'file_structure.txt'
    # Add directories to ignore here
    ignored_directories = ['__pycache__', '.git', 'venv', 'venv2']
    generate_structure(project_directory, output_filename, ignored_directories)
    print(f"File structure has been generated in '{output_filename}'")
