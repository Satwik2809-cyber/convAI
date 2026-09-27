const xlsx = require('xlsx');
const path = require('path');

const relPath = String.raw`C:\Users\shrey\Downloads\Conv-mvp\Conv-mvp\Sample Data for ConversalX-20260502T120557Z-3-001\Relationship-2.xlsx`;
const masterPath = String.raw`C:\Users\shrey\Downloads\Conv-mvp\Conv-mvp\Sample Data for ConversalX-20260502T120557Z-3-001\Students_Master_List_v2.xlsx`;

const relWorkbook = xlsx.readFile(relPath);
const relSheet = relWorkbook.Sheets[relWorkbook.SheetNames[0]];
const relData = xlsx.utils.sheet_to_json(relSheet);

console.log("Found", relData.length, "relationships. First 3:");
for(let i=0; i<3; i++) {
    console.log(`Parent: ${relData[i].Parent_First_Name} ${relData[i].Parent_Second_Name} -> Student: ${relData[i].Student_First_Name} ${relData[i].Student_Second_Name}`);
}
