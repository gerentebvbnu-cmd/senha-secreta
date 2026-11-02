import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.senhasecreta.mobile',
  appName: 'Senha Secreta',
  webDir: 'dist',
  server: { androidScheme: 'https' }
}
export default config
