# Guia de instalação e backups — FISIO IF

## Antes de começar

A FISIO IF é uma PWA: os ficheiros da interface são carregados a partir de um endereço web, mas os dados introduzidos ficam localmente no dispositivo. Não existe conta, servidor de dados ou sincronização.

A aplicação e a instalação não exigem App Store nem subscrição. Contudo, o modo offline depende de um **endereço HTTPS estável** para o primeiro carregamento e para futuras atualizações. Esta pasta de projeto não está publicada. Um alojamento estático com HTTPS pode ter uma modalidade gratuita, mas as condições e limites pertencem ao respetivo fornecedor e devem ser confirmados antes da escolha.

Não é suficiente copiar a pasta para a app Ficheiros e tocar em `index.html`. A aplicação precisa de ser servida por HTTP em `localhost` para testes no Mac ou por HTTPS para utilização no iPhone.

## Instalar no iPhone

1. Disponibilizar a pasta da aplicação num endereço HTTPS estável, sem alterar os nomes ou caminhos dos ficheiros.
2. No iPhone, abrir esse endereço no **Safari**.
3. Esperar que a interface carregue completamente.
4. Tocar no botão **Partilhar**.
5. Escolher **Adicionar ao ecrã principal**. Se a opção não aparecer, usar **Editar ações** para a ativar.
6. Manter ativa a opção **Abrir como aplicação web**, quando for apresentada.
7. Tocar em **Adicionar**.
8. Abrir a FISIO IF pelo novo ícone, ainda com ligação, e esperar pelo primeiro carregamento completo.
9. Fechar a aplicação, ativar temporariamente o modo de voo e voltar a abrir para confirmar o funcionamento offline. Reativar a rede no fim do teste.

Instruções oficiais: [Transformar um site numa app no iPhone — Apple](https://support.apple.com/guide/iphone/iphea86e5236/ios).

### Se o offline não funcionar no primeiro teste

- confirmar que o endereço começa por `https://`;
- abrir novamente no Safari com ligação e recarregar uma vez;
- fechar todas as janelas da aplicação e do mesmo site;
- voltar a abrir pelo ícone;
- confirmar que não está em Navegação privada.

## Instalar no MacBook

### Safari no macOS Sonoma 14 ou posterior

1. Abrir no Safari o mesmo endereço HTTPS usado no iPhone.
2. Escolher **Ficheiro > Adicionar ao Dock** ou **Partilhar > Adicionar ao Dock**.
3. Confirmar o nome **FISIO IF** e escolher **Adicionar**.
4. Abrir pelo Dock ou Spotlight e fazer o primeiro carregamento com ligação.

A Apple documenta este recurso e o requisito de macOS Sonoma 14 em [Usar apps web do Safari no Mac](https://support.apple.com/104996).

### Teste local no Mac, sem publicar

Na pasta `fisio-if`, iniciar um servidor local:

```sh
python3 -m http.server 8080
```

Depois abrir `http://localhost:8080` no Safari. Se necessário, substituir `python3` por `python` ou `py`. O endereço e a porta fazem parte da identidade do armazenamento; usar sempre o mesmo endereço durante os testes.

Este método é adequado ao Mac. `http://localhost:8080` no iPhone apontaria para o próprio iPhone, e `http://<endereço-do-Mac>:8080` não é uma origem segura para o modo offline. Os service workers requerem HTTPS, com uma exceção de desenvolvimento para `localhost`, conforme a [especificação de Service Workers](https://www.w3.org/TR/service-workers/#security-considerations).

## Passar todos os dados do iPhone para o MacBook

1. No iPhone, abrir **Backup** (botão no cabeçalho) na FISIO IF.
2. Escolher **Exportar backup integral**.
3. Na folha de partilha ou no gestor de ficheiros apresentado pelo iOS, escolher **Guardar em Ficheiros**. Selecionar uma pasta conhecida, por exemplo iCloud Drive, ou enviar o ficheiro por AirDrop para o Mac.
4. Confirmar na app Ficheiros que o backup existe e tem tamanho superior a zero.
5. No MacBook, abrir a FISIO IF instalada a partir do mesmo projeto.
6. Escolher **Importar/Restaurar backup** e selecionar o ficheiro exportado.
7. Ler a confirmação apresentada pela aplicação antes de prosseguir: o restauro pode substituir a base existente.
8. No fim, comparar o número de pacientes, pacotes, sessões, avaliações e recebimentos.
9. Exportar um novo backup no MacBook e guardá-lo separadamente como prova do restauro.

Também é possível fazer o percurso inverso. No iPhone, o modo exato de entrega de um download pode variar com a versão do iOS e com o contexto (Safari ou aplicação instalada); se surgir uma pré-visualização ou folha de partilha, usar **Guardar em Ficheiros**. Não assumir que o ficheiro ficou guardado sem o confirmar.

## Exportar para Excel

1. Abrir **Backup** no cabeçalho da FISIO IF.
2. Na área **Exportar para Excel**, tocar em **Criar Excel**.
3. No iPhone, escolher **Guardar em Ficheiros**, AirDrop ou outra opção segura da folha de partilha.
4. Abrir o ficheiro `.xlsx` no Excel, Numbers ou aplicação compatível.

O livro inclui sete folhas: **Resumo, Pacientes, Pacotes, Agenda, Sessões, Avaliações e Recebimentos**. As datas e os valores dos recebimentos são gravados como valores próprios do Excel, permitindo ordenar, filtrar e fazer cálculos.

Na área **Finanças**, o botão **Exportar este relatório** respeita o período, o paciente e o estado escolhidos no dashboard. Na ficha do paciente, **Extrato / imprimir** permite consultar o histórico, imprimir ou guardar em PDF e criar um Excel apenas desse paciente.

Esta exportação contém informação clínica e deve ser protegida como tal. É apenas uma cópia de consulta: não substitui o backup integral JSON e não pode ser importada para restaurar a FISIO IF.

### Isto não é sincronização

Depois do restauro existem duas cópias independentes. Uma consulta criada no iPhone não aparece no MacBook, e vice-versa, até ser feito um novo ciclo manual de exportação e restauro. O modo **Combinar** pode juntar registos por identificador e conservar a versão mais recente, mas não deteta nem resolve alterações concorrentes ao mesmo registo; não equivale a sincronização.

Uma rotina simples é escolher um dispositivo principal, exportar no fim de cada dia de trabalho e guardar pelo menos uma cópia adicional num local seguro. Fazer sempre um backup antes de importar outro.

## Limitações importantes no iPhone e no iOS

### O armazenamento local não é uma garantia de arquivo

O `IndexedDB`, o cache e o service worker pertencem ao endereço de origem da aplicação e são geridos pelo Safari/WebKit. O WebKit descreve o armazenamento normal como “best effort”: pode haver remoção automática sob pressão de espaço, ao exceder quotas globais ou após longos períodos sem uso. Uma aplicação adicionada ao ecrã principal pode beneficiar da política de persistência do sistema, mas isso não substitui backups.

Também pode haver perda ao remover dados de sites nas definições do Safari, apagar a aplicação web, restaurar o dispositivo, usar ferramentas de limpeza ou mudar de endereço. Ver [política de armazenamento do WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/) e [eliminar dados de sites no iPhone — Apple](https://support.apple.com/105082).

### Não usar Navegação privada para trabalho clínico

As garantias e o ciclo de vida do armazenamento são diferentes em Navegação privada. Fazer a instalação e a utilização normal fora desse modo. A Apple explica o comportamento geral em [Navegação privada no iPhone](https://support.apple.com/guide/iphone/browse-the-web-privately-iphb01fc3c85/ios).

### A aplicação pode ser suspensa em segundo plano

O iOS pode suspender separadores e aplicações web quando deixam de estar visíveis. Temporizadores, tarefas contínuas e trabalhos agendados em segundo plano não devem ser considerados garantidos. Esta versão não depende deles para guardar os formulários e não oferece lembretes automáticos de agenda. O WebKit descreve a suspensão de separadores no iOS em [Como o conteúdo web afeta o consumo de energia](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/).

### Primeiro carregamento e atualizações precisam de rede

O uso diário pode ser offline depois de todos os ficheiros da versão terem sido guardados. A primeira abertura e a obtenção de uma versão nova precisam de ligação. Quando houver atualização, abrir com rede, fechar todas as janelas da FISIO IF e voltar a abrir; a atualização foi desenhada para não trocar código a meio de uma sessão.

### O endereço tem de permanecer estável

`https://exemplo.pt`, `http://exemplo.pt`, `https://www.exemplo.pt` e `http://localhost:8080` são origens diferentes e mantêm bases diferentes. Mudar domínio, protocolo ou porta pode fazer a aplicação parecer vazia, mesmo que os dados ainda existam na origem anterior. Exportar antes de qualquer mudança.

### Sem recuperação por conta e sem cópia automática entre dispositivos

Não existe login, nuvem, recuperação de palavra-passe ou sincronização iCloud da aplicação. As cópias gerais do iPhone ou do Safari não devem ser usadas como substituto do botão **Exportar backup integral**.

### Exportar e importar exige uma ação visível

O iOS não permite que esta aplicação escreva silenciosamente numa pasta arbitrária. O utilizador tem de confirmar o destino do backup através do seletor de ficheiros ou da folha de partilha. Guardar o ficheiro e confirmar a sua existência antes de apagar ou substituir dados.

## Segurança dos dados

- Usar código de acesso forte e Face ID/Touch ID no iPhone.
- Ativar FileVault e bloqueio automático no MacBook.
- Não guardar backups clínicos em pastas partilhadas ou enviar por canais não aprovados.
- Não deixar o ficheiro de backup em Downloads depois de o copiar para o arquivo seguro.
- Não introduzir dados reais num dispositivo partilhado.
- Recordar que não há login nem encriptação adicional dentro da própria FISIO IF.

### Reciclagem local

Os registos eliminados individualmente e as fichas de pacientes são movidos para **Definições > Reciclagem**, onde podem ser recuperados. A reciclagem guarda no máximo 50 operações e pertence apenas ao dispositivo atual. **Esvaziar a reciclagem**, apagar todos os dados do Safari ou usar **Apagar tudo** remove essa possibilidade de recuperação; o backup integral continua a ser a proteção principal.

## Checklist mensal recomendado

- Criar um backup integral.
- Criar uma exportação Excel de consulta, se necessária, e guardá-la num local protegido.
- Confirmar que o ficheiro abre no seletor de importação.
- Fazer um restauro de teste num perfil/dispositivo sem dados reais.
- Confirmar os totais de pacientes, pacotes, sessões e recebimentos.
- Manter pelo menos duas cópias em locais distintos e protegidos.
- Apagar com segurança backups antigos quando a política de retenção o exigir.


