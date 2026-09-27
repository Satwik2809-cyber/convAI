const mammoth = require("mammoth");

const filePath = String.raw`C:\Users\shrey\Downloads\Conv-mvp\Conv-mvp\Sample Data for ConversalX-20260502T120557Z-3-001\wetransfer_2-reports-in-word-format-for-salim-conversalx-research_2025-12-27_1206\Class - 1st A\1st - A (Roll no.1).docx`;

mammoth.extractRawText({path: filePath})
    .then(function(result){
        var text = result.value; // The raw text
        console.log(text.substring(0, 1000));
        var messages = result.messages;
    })
    .catch(function(error) {
        console.error(error);
    });
