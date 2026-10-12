# FISIO IF — versão 1.4.0 offline

FISIO IF é uma aplicação web instalável (PWA), orientada primeiro ao iPhone e utilizável também no MacBook. A aplicação gere pacientes, pacotes de sessões, sessões avulsas, agenda, avaliações e recebimentos sem conta, subscrição, servidor de dados ou sincronização.

Os registos ficam no `IndexedDB` do navegador de cada dispositivo. A transferência entre iPhone e MacBook é manual: exporta-se um backup integral num dispositivo e importa-se no outro.

> **Importante:** esta é uma primeira versão testável. Antes de introduzir dados clínicos reais, validar o fluxo completo, a política de backups e as obrigações profissionais e legais aplicáveis. A aplicação não acrescenta encriptação própria aos dados nem ao ficheiro de backup.

## O que está incluído

- base de pacientes;
- pacotes de sessões, com contadores independentes de sessões realizadas, pagas e pendentes;
- pagamentos faseados de pacotes, sem confundir sessões pagas com sessões já realizadas;
- registo de sessões avulsas ou incluídas num pacote;
- agenda local;
- agenda com vistas diária, semanal e mensal, estados por cor e aviso de sobreposição;
- avaliações clínicas;
- reavaliações associadas à avaliação inicial e duplicação de sessões anteriores;
- dashboard de recebimentos com filtros mensal, anual, por paciente e por estado pago/pendente;
- datas previstas, identificação de pagamentos em atraso e passagem rápida para pago;
- resumo completo por paciente e extrato imprimível;
- reciclagem local para recuperar eliminações acidentais;
- exportação integral para um ficheiro de backup;
- exportação integral ou filtrada para um ficheiro Excel (`.xlsx`) com folhas separadas para resumo, pacientes, pacotes, agenda, sessões, avaliações e recebimentos;
- importação/restauro do backup;
- interface adaptada ao iPhone e ao MacBook;
- funcionamento offline depois do primeiro carregamento completo;
- instalação como aplicação a partir do Safari, sem App Store.

Não há login, nuvem, sincronização automática, telemetria, serviços pagos ou dependências online durante a utilização normal.

## Estrutura do projeto

```text
fisio-if/
├── index.html
├── manifest.webmanifest
├── sw.js
├── offline.html
├── GUIA-INSTALACAO.md
└── assets/
    ├── css/styles.css
    ├── js/app.js
    ├── js/db.js
    ├── js/backup.js
    ├── js/excel.js
    └── icons/
```

## Testar gratuitamente no MacBook

Não abrir `index.html` diretamente através de `file://`: os módulos JavaScript e o modo offline da PWA precisam de um servidor web.

Na pasta `fisio-if`, iniciar um servidor local, por exemplo:

```sh
python3 -m http.server 8080
```

Se o comando disponível for `python` ou `py`, usar esse nome em vez de `python3`. Depois abrir [http://localhost:8080](http://localhost:8080) no Safari.

`localhost` é aceite para desenvolvimento. Num iPhone, o endereço local do Mac (por exemplo, `http://192.168...`) não equivale a `localhost` e normalmente não permite ativar o service worker. Para instalar e testar no iPhone é necessário disponibilizar estes ficheiros num endereço HTTPS alcançável pelo telefone.

## Teste funcional sugerido

Usar apenas dados fictícios durante o teste inicial.

1. Abrir a aplicação com ligação e percorrer todos os ecrãs.
2. Criar um paciente e um pacote de 20 sessões a 30 €, registando o pagamento inicial de 10 sessões.
3. Criar uma sessão incluída nesse pacote e confirmar que o pacote mostra 1 sessão realizada e 10 sessões pagas.
4. Registar um segundo pagamento de 10 sessões como pendente e confirmar no dashboard que aparecem 300 € recebidos e 300 € pendentes.
5. Atribuir uma data prevista anterior à data atual e confirmar o estado “Em atraso”; depois usar “Dar como pago”.
6. Criar uma avaliação, abrir uma reavaliação associada e testar a duplicação de uma sessão.
7. Criar um evento de agenda, alternar entre Dia/Semana/Mês e confirmar o aviso ao sobrepor horários.
8. Eliminar um registo, recuperá-lo na Reciclagem e confirmar que reaparece.
9. Abrir o extrato do paciente e testar a impressão/guardar como PDF.
10. Fechar e voltar a abrir; confirmar que os registos permanecem.
11. Depois de um carregamento completo, desligar a rede e voltar a abrir a aplicação.
12. Exportar um backup e confirmar que o ficheiro foi guardado fora da aplicação.
13. Criar uma exportação Excel integral e outra filtrada; confirmar que as sete folhas abrem corretamente.
14. Num perfil de navegador ou dispositivo de teste, importar o backup JSON e confirmar todos os totais e registos.
15. Criar um segundo backup depois do restauro e guardá-lo separadamente.

## Atualizações da aplicação

O service worker usa um cache com versão. Uma atualização não substitui os ficheiros a meio de uma sessão: fica à espera que todas as janelas FISIO IF da versão anterior sejam fechadas. Ao disponibilizar uma versão nova:

1. alterar `APP_VERSION` em `sw.js`;
2. publicar todos os ficheiros em conjunto;
3. no dispositivo, abrir a aplicação com ligação, fechar todas as janelas da FISIO IF e voltar a abrir.

O cache contém apenas os ficheiros estáticos da aplicação. Os dados de pacientes continuam no `IndexedDB` e não são colocados no cache do service worker.

## Cópias de segurança

O backup exportado é a única cópia portátil e controlada pelo utilizador. Guardá-lo num local seguro e fazer cópias regulares, sobretudo antes de atualizar o sistema, limpar dados do Safari, remover a aplicação ou importar outro backup.

O Excel destina-se a consulta, filtros, impressão e análise. Inclui informação clínica sensível, mas **não permite restaurar a aplicação**. Para restauro entre dispositivos é obrigatório conservar o backup integral em formato JSON.

O iPhone e o MacBook mantêm bases independentes. Mesmo no modo **Combinar**, importar é um restauro controlado, não uma sincronização: os registos são combinados por identificador, mas alterações posteriores em cada dispositivo não passam automaticamente para o outro.

Consulte [GUIA-INSTALACAO.md](./GUIA-INSTALACAO.md) para instalação no iPhone e no MacBook, transferência de backup e limitações do iOS.

## Privacidade e segurança

- Os dados não são enviados pela aplicação para um servidor.
- Quem conseguir desbloquear o dispositivo e abrir a aplicação pode ver os dados, porque não existe login interno.
- O ficheiro de backup contém informação legível pela aplicação e deve ser tratado como informação clínica confidencial.
- A proteção prática depende do código de acesso, FileVault e restantes controlos do dispositivo, além da guarda segura dos backups.
- Apagar dados do site, trocar de origem/endereço ou remover armazenamento do navegador pode tornar a base local inacessível.

## Compatibilidade esperada

A versão foi desenhada para Safari recente no iPhone e no macOS. A instalação como aplicação no Mac através de **Adicionar ao Dock** requer macOS Sonoma 14 ou posterior; em versões anteriores, pode ser usada num separador do navegador. Outros navegadores modernos podem funcionar, mas o fluxo principal desta primeira versão é Safari.


