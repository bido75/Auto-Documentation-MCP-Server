Auto-Documentation MCP Server Technical Design
Product Intent
The Auto-Documentation MCP Server is a quiet documentation companion for software development. It watches development evidence, detects completed manual-worthy features, generates concise user and admin documentation, and keeps a living Notion manual ready for release packaging.

The product exists because most teams leave manuals until the end of a project, when context is stale and documentation becomes rushed or missing. This system captures the important details while the work is fresh, then turns them into a polished manual without requiring developers to manually write entries.

Goals
Automatically capture documentation-worthy product changes for solo developers and teams.
Generate crisp user and admin manual entries, not noisy code summaries.
Deduplicate documentation so repeated changes update existing feature entries.
Use confidence scoring to decide whether to auto-publish or queue human review.
Store the living manual in Notion using structured databases and pages.
Package release-ready manuals from approved or auto-published entries.
Non-Goals For MVP
Full replacement for engineering design docs.
Deep static analysis for every programming language.
Automatic screenshot upload as a required path.
PDF generation inside the first server release.
Real-time filesystem watching as the only capture path.
Primary Users
Solo Developer
The solo developer works locally with an AI coding assistant. The system watches local git state, commits, changed files, tests, and AI session summaries. High-confidence documentation can be published automatically.

Team
The team uses GitHub pull requests, CI, reviews, and releases. The system consumes PR metadata, merge events, linked issues, CI status, and release tags. Medium-confidence documentation is routed through Notion review status before publishing.

Core Workflow
Developer works normally
        |
Development signal appears
        |
Evidence collector records event
        |
Documentation analyzer decides whether the event is manual-worthy
        |
Feature key resolver matches or creates a stable feature identity
        |
Documentation generator creates user/admin/developer sections
        |
Confidence scorer assigns publish confidence
        |
Notion writer upserts docs and sets review status
        |
Manual packager assembles release-ready manual
Trigger Model
The MVP uses a hybrid trigger model.

Local Signals
Last commit.
Staged diff.
Working tree diff.
Branch name.
Test command result when available.
AI coding assistant completion summary when available.
Team Signals
Pull request title and body.
Pull request diff summary.
Linked issue references.
Review comments.
CI status.
Merge commit.
Release tag.
Manual triggering may exist as a debug path, but it is not part of the product promise. The normal user experience should require no manual documentation action.

Manual-Worthy Decision Rules
The analyzer should document changes that affect how a user, admin, support person, or operator uses the product.

User Manual Worthy
New screen, page, dashboard, report, form, button, setting, or workflow.
Changed behavior visible to end users.
New validation, error state, onboarding flow, notification, export, import, auth, billing, or account behavior.
New permission-visible capability.
Admin Manual Worthy
New role, permission, policy, integration, webhook, environment variable, deployment setting, or operational workflow.
New API endpoint that admins or integrators use.
New database, monitoring, audit, security, compliance, recovery, or troubleshooting behavior.
Changed setup or configuration requirements.
Usually Ignored
Formatting-only changes.
Test-only changes.
Internal refactors with no behavior change.
Dependency updates unless they affect setup, security, compatibility, or operation.
Low-level implementation details that do not help users or admins.
Architecture
MCP Server
  exposes tools and stores local configuration

Auto-Doc Agent
  orchestrates capture, analysis, scoring, and publishing

Evidence Collectors
  local git collector
  GitHub collector
  CI/release collector
  AI session collector

Documentation Analyzer
  impact classifier
  feature key resolver
  deduplication engine
  confidence scorer

Notion Writer
  schema initializer
  feature upsert
  manual entry upsert
  review status updater

Manual Packager
  release summary builder
  user manual export
  admin manual export
MCP Tools
initialize_project_manual
Creates the Notion database structure for a project and returns the database IDs needed by later tools.

Inputs:

projectName
parentPageId
repositoryUrl
publishingMode
autoPublishThreshold
Outputs:

Project database ID.
Features database ID.
Manual entries database ID.
Evidence events database ID.
Releases database ID.
capture_development_event
Stores raw development evidence from local git, GitHub, CI, release, or AI-session sources.

Inputs:

projectId
source
eventType
summary
commitSha
branch
prUrl
releaseVersion
filesChanged
diffSummary
testStatus
Outputs:

Evidence event ID.
Initial manual-worthy classification.
analyze_documentation_candidate
Classifies captured evidence, determines user/admin relevance, resolves a stable feature key, and computes confidence.

Inputs:

projectId
evidenceEventIds
existingFeatureKeys
Outputs:

shouldDocument
featureKey
featureName
audiences
entryTypes
confidenceScore
confidenceReasons
reviewQuestions
upsert_feature_documentation
Creates or updates the Notion feature and manual entries. This is the primary deduplication-aware write path.

Inputs:

projectId
featureKey
featureName
module
audiences
manualEntries
evidenceEventIds
confidenceScore
confidenceReasons
Outputs:

Feature page ID.
Manual entry page IDs.
Publishing status.
publish_or_queue_review
Applies the project publishing policy to a generated documentation candidate.

Inputs:

projectId
featureId
manualEntryIds
confidenceScore
publishingMode
Outputs:

Final status: Captured, Needs Review, Approved, or Published.
Review notes.
package_manual
Builds a release-ready manual from published or approved entries.

Inputs:

projectId
releaseVersion
audience
format
Outputs:

Notion page URL or generated Markdown content.
Included entry count.
Excluded entry count and reasons.
get_documentation_status
Reports documentation health for a project or release.

Inputs:

projectId
releaseVersion
Outputs:

Published count.
Needs review count.
Captured count.
Low confidence count.
Missing review questions.
Notion Database Schema
Projects
Property	Type	Purpose
Project Name	Title	Human-readable project name.
Repository URL	URL	Main repository location.
Publishing Mode	Select	Conservative, Balanced, Fully Automatic.
Auto Publish Threshold	Number	Confidence score required for automatic publishing.
Manual Home	URL	Primary Notion manual page or database URL.
Current Release	Rich text	Active release version.
Documentation Health	Status	Healthy, Needs Review, Behind.
Features
Property	Type	Purpose
Feature Name	Title	Stable feature display name.
Feature Key	Rich text	Deduplication key generated from route/module/domain.
Project	Relation	Owning project.
Module	Select	Product area such as Auth, Billing, Admin Panel, Reports, API.
Audience Impact	Multi-select	User, Admin, Developer, Support.
Status	Status	Captured, Needs Review, Approved, Published, Deprecated.
First Seen Commit	Rich text	First source commit.
Last Documented Commit	Rich text	Latest source commit included in docs.
Release Introduced	Rich text	Release where feature first appears.
Confidence Score	Number	Latest confidence score.
Manual Entries
Property	Type	Purpose
Entry Title	Title	Manual section title.
Entry Type	Select	User Guide, Admin Guide, Developer Note, Release Note.
Audience	Select	User, Admin, Both, Internal.
Project	Relation	Owning project.
Feature	Relation	Related feature.
Release	Relation	Related release.
Status	Status	Captured, Needs Review, Approved, Published, Deprecated.
Confidence Score	Number	Score used for publishing decision.
Publishing Decision	Select	Agent Published, Queued Review, Human Approved, Ignored.
Source Commit	Rich text	Commit that generated or updated the entry.
Source PR	URL	PR URL when available.
Files Changed	Rich text	Important source files.
Routes / URLs	Rich text	User-facing routes.
API Endpoints	Rich text	Admin or integration endpoints.
Date Captured	Date	Initial capture date.
Date Published	Date	Publication date.
Reviewer Notes	Rich text	Human review notes.
Evidence Events
Property	Type	Purpose
Event Title	Title	Short event label.
Project	Relation	Owning project.
Source	Select	Local Git, GitHub, CI, Release, AI Session.
Event Type	Select	Commit, Diff, PR Opened, PR Merged, Tests Passed, Release Tagged, Session Completed.
Commit SHA	Rich text	Commit identifier.
Branch	Rich text	Branch name.
PR URL	URL	Pull request URL.
Release Version	Rich text	Release version.
Files Changed	Rich text	Changed file list.
Diff Summary	Rich text	Concise diff summary.
Test Status	Select	Passed, Failed, Unknown, Not Run.
Captured At	Date	Capture timestamp.
Releases
Property	Type	Purpose
Release Version	Title	Version name.
Project	Relation	Owning project.
Status	Status	Planned, In Progress, Ready, Released.
Release Date	Date	Ship date.
Included Features	Relation	Features in release.
Manual URL	URL	Packaged release manual.
User Entries Count	Number	Count of included user docs.
Admin Entries Count	Number	Count of included admin docs.
Confidence Scoring
The confidence scorer returns a number from 0 to 100 with explainable reasons.

Positive Signals
Feature name appears in PR title, issue title, branch, or commit message.
User-facing files changed.
Routes, UI components, forms, settings, or API endpoints are detected.
Tests passed.
PR merged or release tagged.
Existing feature key matched cleanly.
Generated documentation contains concrete steps, nouns, and expected outcomes.
Negative Signals
Change appears to be formatting-only, test-only, or refactor-only.
No user or admin impact is detected.
Feature purpose is ambiguous.
Evidence conflicts across commits, diffs, and PR text.
Existing feature match is uncertain.
Generated documentation contains vague phrases such as "various improvements" without concrete behavior.
Publishing Modes
Mode	Behavior
Conservative	All manual entries are saved as Needs Review.
Balanced	Entries at or above threshold are Published; medium scores are Needs Review; low scores are Captured.
Fully Automatic	Entries are Published unless the score is low or the analyzer detects a contradiction.
Default MVP mode: Balanced.

Default auto-publish threshold: 90.

Documentation Content Rules
User guide entries must answer:

What can the user do now?
Where does the user go?
What action does the user take?
What result should the user expect?
What errors or edge states might the user see?
Admin guide entries must answer:

What must be configured?
Which permissions, roles, integrations, endpoints, or environment variables matter?
What operational workflow changed?
How should an admin verify the feature works?
What troubleshooting information belongs in the manual?
Developer notes are included only when they help deployment, support, maintenance, integrations, or release operations.

Error Handling
Missing Notion token returns a clear MCP error.
Missing database IDs returns a project initialization error.
Notion rate limits are retried with exponential backoff.
Notion validation errors include the property name and attempted value.
Analyzer failures store the evidence event and mark it Captured rather than losing the signal.
Duplicate feature matches below confidence threshold are queued for review.
Security And Privacy
Notion tokens are read only from environment variables.
Raw diffs are not stored in Notion by default; the MVP stores summaries and file lists.
Secret-looking values in diffs are redacted before storage.
Local repository paths are never published to user-facing manual entries.
Project settings can disable developer notes for external manuals.
Testing Strategy
Unit tests for Notion block rendering.
Unit tests for confidence scoring.
Unit tests for manual-worthy classification.
Unit tests for feature key generation and deduplication.
Integration tests using mocked Notion API calls.
Fixture-based tests for local git evidence parsing.
End-to-end dry run that captures a synthetic feature and generates Notion payloads without calling Notion.
MVP Acceptance Criteria
A TypeScript MCP server starts over stdio.
The server can initialize the full Notion schema.
The server can capture local git evidence.
The analyzer can classify manual-worthy changes.
The writer can upsert feature and manual entries without duplication.
Confidence-gated publishing works in Conservative, Balanced, and Fully Automatic modes.
A release manual can be packaged from Published and Approved entries.
The project supports solo local usage and team GitHub/PR metadata inputs through the same core pipeline.