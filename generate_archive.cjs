const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const outputBase = path.join(__dirname, 'Project_Codebase');

// Priority files (in order)
const priorityFiles = [
  'src\\app.js',
  'src\\handlers\\commandLoader.js',
  'src\\services\\antinukeService.js',
  'src\\utils\\database.js'
];

// Get all .js files recursively
function getAllJsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(srcDir, fullPath);
    if (entry.isDirectory()) {
      results.push(...getAllJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

function sortFiles(files) {
  const priority = [];
  const rest = [];
  
  for (const file of files) {
    const relPath = path.relative(process.cwd(), file);
    
    let found = false;
    for (let i = 0; i < priorityFiles.length; i++) {
      if (relPath === priorityFiles[i]) {
        priority[i] = file;
        found = true;
        break;
      }
    }
    if (!found) {
      rest.push(file);
    }
  }
  
  // Filter out undefined slots and sort rest alphabetically
  const sortedPriority = priority.filter(f => f !== undefined);
  rest.sort((a, b) => a.localeCompare(b));
  
  return [...sortedPriority, ...rest];
}

// Maximum characters per part (to stay within token limits)
const MAX_CHARS_PER_PART = 800000; // ~200K tokens per part

function generateArchive() {
  const allFiles = getAllJsFiles(srcDir);
  const sortedFiles = sortFiles(allFiles);
  
  let partNumber = 1;
  let currentContent = '';
  let parts = [];
  
  for (const filePath of sortedFiles) {
    const relPath = path.relative(process.cwd(), filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      content = `[ERROR READING FILE: ${err.message}]`;
    }
    
    const fileBlock = `##### FILE: ${relPath}\n${content}\n`;
    
    // Check if adding this file would exceed the limit
    if (currentContent.length + fileBlock.length > MAX_CHARS_PER_PART && currentContent.length > 0) {
      parts.push(currentContent.trimEnd());
      currentContent = '';
      partNumber++;
    }
    
    currentContent += fileBlock + '\n';
  }
  
  // Push remaining content
  if (currentContent.trim().length > 0) {
    parts.push(currentContent.trimEnd());
  }
  
  // Write output files
  if (parts.length === 1) {
    const outputPath = outputBase + '.txt';
    fs.writeFileSync(outputPath, parts[0], 'utf8');
    console.log(`Created: ${outputPath} (${parts[0].length} characters)`);
  } else {
    for (let i = 0; i < parts.length; i++) {
      const outputPath = `${outputBase}_Part${i + 1}.txt`;
      fs.writeFileSync(outputPath, parts[i], 'utf8');
      console.log(`Created: ${outputPath} (${parts[i].length} characters)`);
    }
  }
  
  console.log(`\nTotal parts: ${parts.length}`);
  console.log(`Total files archived: ${sortedFiles.length}`);
}

generateArchive();