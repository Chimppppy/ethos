import 'dotenv/config';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export const PRODUCTS = ['transactions'];
export const COUNTRY_CODES = ['US', 'CA'];
export const DEFAULT_TRANSACTIONS_DAYS_REQUESTED = 730;

export function plaidEnvName() {
  return (process.env.PLAID_ENV || 'sandbox').toLowerCase();
}

export function transactionsDaysRequested(overrideValue = undefined) {
  const rawValue = overrideValue ?? process.env.PLAID_TRANSACTIONS_DAYS_REQUESTED ?? String(DEFAULT_TRANSACTIONS_DAYS_REQUESTED);
  const days = Number(rawValue);
  if (!Number.isInteger(days) || days < 1 || days > 730) {
    throw new Error('PLAID_TRANSACTIONS_DAYS_REQUESTED must be an integer from 1 to 730');
  }
  return days;
}

export function getPlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const envName = plaidEnvName();
  const basePath = PlaidEnvironments[envName];

  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET are required');
  }
  if (!basePath) {
    throw new Error(`Unsupported PLAID_ENV "${envName}". Use sandbox, development, or production.`);
  }

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret
      }
    }
  });

  return new PlaidApi(config);
}

export async function getInstitutionName(client, institutionId) {
  if (!institutionId) {
    return null;
  }

  const response = await client.institutionsGetById({
    institution_id: institutionId,
    country_codes: COUNTRY_CODES
  });

  return response.data.institution?.name ?? null;
}
