import { type AuthContext, assertOwnership } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { type PublicReading, findLatestReadingForField, toPublicReading } from '../readings/readings.repo';
import type { CreateFieldBody } from './fields.dto';
import {
  type FieldRow,
  type PublicField,
  createField as createFieldRow,
  findFieldById,
  listFieldsByFarmer,
  toPublicField,
} from './fields.repo';

/** List the caller's own fields, newest first. */
export async function listFields(auth: AuthContext): Promise<PublicField[]> {
  const rows = await listFieldsByFarmer(auth.farmerId);
  return rows.map(toPublicField);
}

export async function createField(
  auth: AuthContext,
  input: CreateFieldBody,
): Promise<PublicField> {
  const row = await createFieldRow(auth.farmerId, input);
  return toPublicField(row);
}

/**
 * Load a field the caller is allowed to touch, or throw. Shared by the field,
 * reading and recommendation routes so ownership is enforced in exactly one
 * place. Returns the raw row (callers that need `area_ha`/`region_code` for the
 * money path read them directly).
 */
export async function getOwnedFieldOrThrow(
  auth: AuthContext,
  fieldId: string,
): Promise<FieldRow> {
  const field = await findFieldById(fieldId);
  if (!field) throw new AppError('FIELD_NOT_FOUND', 'Field not found', 404);
  assertOwnership(field.farmer_id, auth);
  return field;
}

/** GET /v1/fields/:id — the field plus its most recent reading (§6.2). */
export async function getFieldDetail(
  auth: AuthContext,
  fieldId: string,
): Promise<{ field: PublicField; latest_reading: PublicReading | null }> {
  const field = await getOwnedFieldOrThrow(auth, fieldId);
  const latest = await findLatestReadingForField(fieldId);
  return {
    field: toPublicField(field),
    latest_reading: latest ? toPublicReading(latest) : null,
  };
}
