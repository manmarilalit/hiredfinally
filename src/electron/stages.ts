function detectApplicationStage(url: string, bodyText: string): string {
    const urlLower = url.toLowerCase();
    const bodyTextLower = bodyText.toLowerCase(); 

    if (bodyTextLower.includes("submitted")) {
        return "COMPLETED";
    }

    if (urlLower.includes("resume") || urlLower.includes("form")) {
        return "IN_PROGRESS";
    }
    if (bodyTextLower.includes("resume") || bodyTextLower.includes("authorized to work")) {
        return "IN_PROGRESS";
    }
    
    if (urlLower.includes("indeed") || urlLower.includes("vkj") || urlLower.includes("job")) {
        return "NOT_STARTED";
    }     



    return "UNKNOWN";
}

module.exports = { detectApplicationStage };
