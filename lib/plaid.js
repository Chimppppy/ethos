import 'dotenv/config';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export const PRODUCTS = ['transactions'];
export const COUNTRY_CODES = ['US', 'CA'];

export function plaidEnvName() {
  return (process.env.PLAID_ENV || 'sandbox').toLowerCase();
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
