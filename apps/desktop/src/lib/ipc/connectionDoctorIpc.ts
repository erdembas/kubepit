import type { ConnectionDoctorReport } from '@/types/connectionDoctor';
import { call } from './invoke';

export const connectionDoctorIpc = {
  connectionDoctorRun: (clusterId: string, namespace?: string | null) =>
    call<ConnectionDoctorReport>('connection_doctor_run', {
      clusterId,
      namespace: namespace ?? null,
    }),
};
