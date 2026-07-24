export type IntegrationResult<T> = {
  idempotencyKey: string;
  status: "SUCCEEDED" | "FAILED" | "DUPLICATE";
  data?: T;
  error?: string;
};

export interface FSMAdapter {
  syncCustomers(key: string): Promise<IntegrationResult<{ imported: number }>>;
  syncProperties(key: string): Promise<IntegrationResult<{ imported: number }>>;
  syncTechnicians(key: string): Promise<IntegrationResult<{ imported: number }>>;
  syncJobs(key: string): Promise<IntegrationResult<{ imported: number }>>;
  writeAppointment(key: string, appointmentId: string): Promise<IntegrationResult<{ externalId: string }>>;
  writeJobCompletion(key: string, jobId: string): Promise<IntegrationResult<{ externalId: string }>>;
}

export interface MapsAdapter {
  estimateDriveMinutes(origin: string, destination: string): Promise<number>;
}

export interface WeatherAdapter {
  getOperationalConditions(postalCode: string): Promise<{ summary: string; advisory: boolean }>;
}

export interface CommunicationsAdapter {
  sendServiceProof(key: string, recipientId: string, reportId: string): Promise<IntegrationResult<{ messageId: string }>>;
}

export interface ObjectStorageAdapter {
  createUploadUrl(input: { organizationId: string; objectKey: string; contentType: string }): Promise<{ url: string; expiresAt: string }>;
}

export class MockFSMAdapter implements FSMAdapter {
  private seen = new Set<string>();
  private result<T>(key: string, data: T): IntegrationResult<T> {
    if (this.seen.has(key)) return { idempotencyKey: key, status: "DUPLICATE" };
    this.seen.add(key);
    return { idempotencyKey: key, status: "SUCCEEDED", data };
  }
  async syncCustomers(key: string) { return this.result(key, { imported: 40 }); }
  async syncProperties(key: string) { return this.result(key, { imported: 50 }); }
  async syncTechnicians(key: string) { return this.result(key, { imported: 8 }); }
  async syncJobs(key: string) { return this.result(key, { imported: 120 }); }
  async writeAppointment(key: string, appointmentId: string) { return this.result(key, { externalId: `mock-appt-${appointmentId}` }); }
  async writeJobCompletion(key: string, jobId: string) { return this.result(key, { externalId: `mock-job-${jobId}` }); }
}

export class CSVImportAdapter extends MockFSMAdapter {}

export class MockMapsAdapter implements MapsAdapter {
  async estimateDriveMinutes() { return 11; }
}

export class MockWeatherAdapter implements WeatherAdapter {
  async getOperationalConditions() { return { summary: "Dry, 72°F", advisory: false }; }
}

export class MockCommunicationsAdapter implements CommunicationsAdapter {
  async sendServiceProof(key: string, _recipientId: string, reportId: string) {
    return { idempotencyKey: key, status: "SUCCEEDED" as const, data: { messageId: `msg-${reportId}` } };
  }
}
