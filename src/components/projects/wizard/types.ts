import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../../convex/_generated/api'

/** The single read every wizard step works from. */
export type ProjectDetail = FunctionReturnType<typeof api.projects.getBySlug>
export type WizardProject = ProjectDetail['project']
export type WizardQuestion = ProjectDetail['questions'][number]
export type WizardCriterion = ProjectDetail['criteria'][number]
