import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const constraintSchema = z.object({
    id: z.string(),
    text: z.string(),
});

const requirementSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    constraints: z.array(constraintSchema),
});

const requirementGroupSchema = z.object({
    id: z.string().describe('Sequential group ID, e.g. GRP_01'),
    name: z.string().describe('Short name of the feature area / story, e.g. "Energy Monitoring"'),
    requirementIds: z.array(z.string()).describe('Ordered list of requirement IDs belonging to this group'),
});

const skillSchema = z.object({
    id: z.string(),
    name: z.string(),
    category: z.object({
        id: z.string(),
        name: z.string(),
    }).optional(),
});

const reviewerInfoSchema = z.object({
    scorecardId: z.string(),
    isMemberReview: z.boolean(),
    type: z.string().optional(),
    aiWorkflowId: z.string().optional(),
});

/**
 * Runtime environment **expectations** extracted solely from the challenge
 * specification (JSON).  At this stage no submission exists yet — every field
 * reflects what the challenge *requires or implies*, not what a submission
 * actually provides.
 */
const runtimeEnvironmentSchema = z.object({
    os: z.string().nullable().describe('Expected target operating system (e.g. "Linux", "Windows", "macOS", "any", "unknown")'),
    containerized: z.boolean().nullable().describe('Whether the challenge expects the solution to run inside a container (Docker, Podman, etc.)'),
    containerTool: z.string().nullable().optional().describe('Expected container tool if containerized (e.g. "Docker", "Docker Compose", "Podman", "Kubernetes")'),
    dockerfileExpected: z.boolean().nullable().optional().describe('Whether the challenge expects a Dockerfile / docker-compose file to be included in the submission'),
    runtimeEngine: z.string().nullable().describe('Expected primary runtime engine (e.g. "Node.js", "Python", "JVM", "Go", ".NET CLR", "browser", "unknown")'),
    runtimeVersion: z.string().nullable().optional().describe('Required runtime version if specified in the challenge (e.g. ">=18", "3.11", "21 LTS")'),
    programmingLanguages: z.array(z.string()).nullable().describe('Programming languages required by the challenge (e.g. ["TypeScript", "Python"])'),
    packageManager: z.string().nullable().optional().describe('Expected package manager if mentioned in the challenge (e.g. "npm", "pnpm", "yarn", "pip", "poetry", "maven")'),
    buildTool: z.string().nullable().optional().describe('Expected build tool if mentioned in the challenge (e.g. "webpack", "vite", "tsc", "gradle", "make")'),
    deploymentTarget: z.string().nullable().optional().describe('Expected deployment target if specified (e.g. "AWS Lambda", "Vercel", "Heroku", "on-premise", "local")'),
    serverType: z.string().nullable().optional().describe('Expected server framework or type if specified (e.g. "Express", "NestJS", "FastAPI", "Spring Boot")'),
    databaseEngine: z.string().nullable().optional().describe('Expected primary database if mentioned in the challenge (e.g. "PostgreSQL", "MongoDB", "DynamoDB")'),
    additionalServices: z.array(z.string()).nullable().optional().describe('Additional services expected by the challenge (e.g. ["Redis", "RabbitMQ", "Elasticsearch"])'),
    notes: z.string().nullable().optional().describe('Any other runtime / environment expectations inferred from the challenge spec'),
});

/**
 * Existing codebase / starting-point information extracted from the challenge
 * specification.  Captures whether the challenge provides pre-existing
 * artifacts (repos, starter code, documentation, designs, APIs, datasets)
 * or if the work is entirely greenfield.
 */
const existingArtifactSchema = z.object({
    type: z.enum([
        'repository', 'starter_code', 'boilerplate', 'documentation',
        'api_spec', 'design', 'dataset', 'database_dump', 'config',
        'library', 'other',
    ]).describe('Kind of pre-existing artifact'),
    description: z.string().describe('What this artifact contains or provides'),
    url: z.string().nullable().optional().describe('URL / link if mentioned (e.g. Git repo, Figma, Swagger)'),
    notes: z.string().nullable().optional().describe('Additional context about this artifact'),
});

const existingCodebaseSchema = z.object({
    isGreenfield: z.boolean().describe(
        'true if the challenge is entirely from scratch with no pre-existing code or artifacts to build upon',
    ),
    summary: z.string().describe(
        'Brief description of the existing codebase / starting-point status '
        + '(e.g. "Existing NestJS API with Prisma ORM — extend with new endpoints" '
        + 'or "Greenfield — build from scratch")',
    ),
    artifacts: z.array(existingArtifactSchema).describe(
        'List of pre-existing artifacts referenced by the challenge (repos, starter code, docs, designs, etc.). '
        + 'Empty array if greenfield.',
    ),
    repositoryUrl: z.string().nullable().optional().describe(
        'Primary Git repository URL if an existing codebase is provided',
    ),
    branchOrTag: z.string().nullable().optional().describe(
        'Branch, tag, or commit reference to use if specified',
    ),
    languages: z.array(z.string()).optional().describe(
        'Programming languages present in the existing codebase (may differ from challenge requirements)',
    ),
    frameworks: z.array(z.string()).optional().describe(
        'Frameworks / libraries already present in the existing codebase',
    ),
    notes: z.string().optional().describe(
        'Any other observations about the starting point inferred from the challenge spec',
    ),
});

/**
 * Structured submission guidelines extracted from the challenge specification.
 * Breaks down the free-form "what / how / where to submit" prose into
 * actionable fields for downstream review automation.
 */
const submissionGuidelinesSchema = z.object({
    summary: z.string().describe(
        'Brief overall summary of the submission requirements in 1-3 sentences',
    ),
    whatToSubmit: z.array(z.string()).describe(
        'List of deliverables the submitter must include '
        + '(e.g. "source code", "README.md", "Postman collection", "Docker setup", "unit tests", "demo video")',
    ),
    howToSubmit: z.string().describe(
        'Instructions on how to package / format the submission '
        + '(e.g. "ZIP archive", "Git patch file", "single commit on a branch")',
    ),
    whereToSubmit: z.string().describe(
        'Submission destination / platform '
        + '(e.g. "Topcoder challenge page", "GitHub pull request", "external URL")',
    ),
    submissionType: z.enum([
        'full_codebase', 'patch', 'link_to_repository',
        'link_to_deployment', 'file_upload', 'other',
    ]).describe(
        'Whether the challenge expects the entire codebase, a patch / diff of an existing codebase, '
        + 'a link to an external Git repository, a link to a running deployment, a file upload, or something else',
    ),
    submissionStorage: z.enum([
        'topcoder_upload', 'git_repository', 'external_file_storage',
        'cloud_deployment', 'other',
    ]).describe(
        'Where the final submission artifact lives — uploaded to Topcoder, '
        + 'pushed to a Git repo, hosted on external file storage (S3, Drive, etc.), '
        + 'deployed to a cloud environment, or other',
    ),
    isPatchOfExisting: z.boolean().describe(
        'true if the submission should be a patch / diff on top of an existing codebase '
        + 'rather than a standalone full codebase. '
        + 'IMPORTANT: This should ONLY be true when existing_codebase.isGreenfield is false '
        + 'AND a concrete repository URL or existing artifacts are provided. '
        + 'If isGreenfield is true (no existing code to patch), isPatchOfExisting MUST be false.',
    ),
    eligibilityConditions: z.array(z.string()).optional().describe(
        'Any conditions that must be met for the submission to be eligible for review '
        + '(e.g. "must pass SAST scanner", "must include unit tests with ≥80% coverage")',
    ),
    notes: z.string().optional().describe(
        'Any additional submission-related information that does not fit the above fields',
    ),
});

const prizeSchema = z.object({
    placement: z.number(),
    value: z.number(),
    currency: z.string(),
});

// ---------------------------------------------------------------------------
// Scorecard Schemas (mirrors GET /v6/scorecards/:id response)
// ---------------------------------------------------------------------------

const scorecardQuestionSchema = z.object({
    id: z.string(),
    type: z.enum(['SCALE', 'YES_NO', 'TEST_CASE']),
    description: z.string(),
    guidelines: z.string(),
    weight: z.number(),
    requiresUpload: z.boolean().optional(),
    scaleMin: z.number().nullable().optional(),
    scaleMax: z.number().nullable().optional(),
    sortOrder: z.number(),
});

const scorecardSectionSchema = z.object({
    id: z.string(),
    name: z.string(),
    weight: z.number(),
    sortOrder: z.number(),
    questions: z.array(scorecardQuestionSchema),
});

const scorecardGroupSchema = z.object({
    id: z.string(),
    name: z.string(),
    weight: z.number(),
    sortOrder: z.number(),
    sections: z.array(scorecardSectionSchema),
});

export const scorecardSchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']),
    type: z.enum([
        'SCREENING', 'REVIEW', 'APPROVAL', 'POST_MORTEM',
        'SPECIFICATION_REVIEW', 'CHECKPOINT_SCREENING',
        'CHECKPOINT_REVIEW', 'ITERATIVE_REVIEW',
    ]),
    challengeTrack: z.string(),
    challengeType: z.string(),
    minScore: z.number(),
    minimumPassingScore: z.number(),
    maxScore: z.number(),
    scorecardGroups: z.array(scorecardGroupSchema),
});

export type Scorecard = z.infer<typeof scorecardSchema>;

export const unifiedContextSchema = z.object({
    challengeId: z.string(),
    title: z.string(),
    descriptionRaw: z.string(),
    privateDescription: z.string().optional(),
    descriptionFormat: z.string(),

    requirements: z.array(requirementSchema),
    requirement_groups: z.array(requirementGroupSchema),
    tech_stack: z.array(z.string()),
    skills: z.array(skillSchema),

    challenge_metadata: z.object({
        status: z.string(),
        track: z.string(),
        type: z.string(),
        totalPrizes: z.number(),
        numOfRegistrants: z.number(),
        numOfSubmissions: z.number(),
        isTask: z.boolean(),
    }),

    timeline: z.object({
        registrationStartDate: z.string(),
        registrationEndDate: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        totalDurationDays: z.number(),
    }),

    prizes: z.array(prizeSchema),

    review_criteria: z.object({
        reviewType: z.string(),
        reviewers: z.array(reviewerInfoSchema),
        scorecard: scorecardSchema.nullable().describe(
            'The human review scorecard fetched from the Topcoder API. '
            + 'null if no human reviewer entry (isMemberReview: true) was found or the API call failed.',
        ),
    }),

    runtime_environment: runtimeEnvironmentSchema.describe(
        'Runtime / execution environment expectations extracted solely from the challenge specification. '
        + 'No submission exists at this point — all values reflect what the challenge requires or implies.',
    ),

    existing_codebase: existingCodebaseSchema.describe(
        'Status quo of the challenge: existing artifacts, codebase, documentation, or starting-point '
        + 'material referenced in the specification. If none, isGreenfield is true and artifacts is empty.',
    ),

    submission_guidelines: submissionGuidelinesSchema.describe(
        'Structured submission guidelines extracted from the challenge specification: '
        + 'what to deliver, how to package it, where to submit, and whether it is a patch or full codebase.',
    ),
    discussion_url: z.string().optional(),
});

// Re-export the output type for downstream consumers
export type UnifiedChallengeContext = z.infer<typeof unifiedContextSchema>;
