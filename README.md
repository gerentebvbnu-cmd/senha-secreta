# Senha Secreta — preparado para APK Android

Projeto React + Supabase preparado para empacotamento Android com Capacitor.

## Supabase
O `.env.local` acompanha o projeto com a URL e a chave publishable fornecida. A chave publishable/anon pode ser usada no cliente; nunca use `service_role` ou secret key no aplicativo.

## Compilar no Windows
1. Instale Node.js LTS: https://nodejs.org/
2. Instale Android Studio: https://developer.android.com/studio
3. Extraia o ZIP e abra um terminal na pasta.
4. Execute `npm install`
5. Execute `npm run build`
6. Execute `npx cap add android`
7. Execute `npx cap sync android`
8. Execute `npx cap open android`
9. No Android Studio, escolha Build > Build Bundle(s) / APK(s) > Build APK(s).

APK de depuração: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Compilação em nuvem
O workflow `.github/workflows/android-apk.yml` compila um APK de depuração no GitHub Actions. Envie o projeto para um repositório GitHub, abra Actions e execute `Build Android APK`. O APK aparecerá como artifact da execução.

## Limitações desta entrega
Este ZIP é o projeto preparado para compilação, não um APK compilado. O ambiente desta conversa não possui Android SDK/Gradle instalado para produzir o APK diretamente. O app também precisa de validação funcional com sessões reais antes de ser considerado pronto para lançamento.
