export function projectDatabaseSchema(): Record<string, unknown> {
  return {
    "Project Name": { title: {} },
    "Repository URL": { url: {} },
    "Publishing Mode": {
      select: {
        options: [
          { name: "Conservative", color: "gray" },
          { name: "Balanced", color: "blue" },
          { name: "Fully Automatic", color: "green" },
        ],
      },
    },
    "Auto Publish Threshold": { number: { format: "number" } },
    "Manual Home": { url: {} },
    "Current Release": { rich_text: {} },
    "Documentation Health": {
      status: {
        options: [
          { name: "Healthy", color: "green" },
          { name: "Needs Review", color: "yellow" },
          { name: "Behind", color: "red" },
        ],
      },
    },
  };
}

export function featuresDatabaseSchema(): Record<string, unknown> {
  return {
    "Feature Name": { title: {} },
    "Feature Key": { rich_text: {} },
    Module: {
      select: {
        options: [
          { name: "Auth", color: "red" },
          { name: "Billing", color: "green" },
          { name: "Admin Panel", color: "purple" },
          { name: "Reports", color: "blue" },
          { name: "API", color: "orange" },
          { name: "Frontend", color: "pink" },
          { name: "Backend", color: "brown" },
          { name: "General", color: "gray" },
        ],
      },
    },
    "Audience Impact": {
      multi_select: {
        options: [
          { name: "User", color: "blue" },
          { name: "Admin", color: "red" },
          { name: "Developer", color: "purple" },
          { name: "Support", color: "green" },
        ],
      },
    },
    Status: {
      status: {
        options: [
          { name: "Captured", color: "gray" },
          { name: "Needs Review", color: "yellow" },
          { name: "Approved", color: "blue" },
          { name: "Published", color: "green" },
          { name: "Deprecated", color: "red" },
        ],
      },
    },
    "First Seen Commit": { rich_text: {} },
    "Last Documented Commit": { rich_text: {} },
    "Release Introduced": { rich_text: {} },
    "Confidence Score": { number: { format: "number" } },
  };
}

export function manualEntriesDatabaseSchema(): Record<string, unknown> {
  return {
    "Entry Title": { title: {} },
    "Entry Type": {
      select: {
        options: [
          { name: "User Guide", color: "blue" },
          { name: "Admin Guide", color: "red" },
          { name: "Developer Note", color: "purple" },
          { name: "Release Note", color: "green" },
        ],
      },
    },
    Audience: {
      select: {
        options: [
          { name: "User", color: "blue" },
          { name: "Admin", color: "red" },
          { name: "Both", color: "green" },
          { name: "Internal", color: "gray" },
        ],
      },
    },
    Status: {
      status: {
        options: [
          { name: "Captured", color: "gray" },
          { name: "Needs Review", color: "yellow" },
          { name: "Approved", color: "blue" },
          { name: "Published", color: "green" },
          { name: "Deprecated", color: "red" },
        ],
      },
    },
    "Confidence Score": { number: { format: "number" } },
    "Publishing Decision": {
      select: {
        options: [
          { name: "Agent Published", color: "green" },
          { name: "Queued Review", color: "yellow" },
          { name: "Human Approved", color: "blue" },
          { name: "Ignored", color: "gray" },
        ],
      },
    },
    "Source Commit": { rich_text: {} },
    "Source PR": { url: {} },
    "Files Changed": { rich_text: {} },
    "Routes / URLs": { rich_text: {} },
    "API Endpoints": { rich_text: {} },
    "Date Captured": { date: {} },
    "Date Published": { date: {} },
    "Reviewer Notes": { rich_text: {} },
  };
}

export function evidenceEventsDatabaseSchema(): Record<string, unknown> {
  return {
    "Event Title": { title: {} },
    Source: {
      select: {
        options: [
          { name: "Local Git", color: "blue" },
          { name: "GitHub", color: "purple" },
          { name: "CI", color: "green" },
          { name: "Release", color: "orange" },
          { name: "AI Session", color: "gray" },
        ],
      },
    },
    "Event Type": {
      select: {
        options: [
          { name: "Commit", color: "blue" },
          { name: "Diff", color: "gray" },
          { name: "PR Opened", color: "purple" },
          { name: "PR Merged", color: "green" },
          { name: "Tests Passed", color: "green" },
          { name: "Release Tagged", color: "orange" },
          { name: "Session Completed", color: "yellow" },
        ],
      },
    },
    "Commit SHA": { rich_text: {} },
    Branch: { rich_text: {} },
    "PR URL": { url: {} },
    "Release Version": { rich_text: {} },
    "Files Changed": { rich_text: {} },
    "Diff Summary": { rich_text: {} },
    "Test Status": {
      select: {
        options: [
          { name: "Passed", color: "green" },
          { name: "Failed", color: "red" },
          { name: "Unknown", color: "gray" },
          { name: "Not Run", color: "yellow" },
        ],
      },
    },
    "Captured At": { date: {} },
  };
}

export function releasesDatabaseSchema(): Record<string, unknown> {
  return {
    "Release Version": { title: {} },
    Status: {
      status: {
        options: [
          { name: "Planned", color: "gray" },
          { name: "In Progress", color: "yellow" },
          { name: "Ready", color: "blue" },
          { name: "Released", color: "green" },
        ],
      },
    },
    "Release Date": { date: {} },
    "Manual URL": { url: {} },
    "User Entries Count": { number: { format: "number" } },
    "Admin Entries Count": { number: { format: "number" } },
  };
}
