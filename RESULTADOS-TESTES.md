# FISIO IF — resultados de validação

Data: 12 de outubro de 2026

## Resultado

A versão 1.4.0 passou os testes automatizados executados neste ambiente.

- validação de sintaxe dos módulos da aplicação e do service worker;
- 18 testes de estrutura, base de dados, integridade de backups e criação de Excel: **18 aprovados, 0 falhados**;
- percurso integral num navegador Chromium em formato iPhone (390 × 844) e MacBook (1365 × 900);
- criação de pacientes, marcações, pacotes, sessões, avaliações e recebimentos;
- criação de um pacote de 20 sessões a 30 €, uma sessão realizada e dois pagamentos faseados de 10 sessões;
- confirmação de que sessões realizadas e sessões pagas são contadas separadamente;
- dashboard de recebimentos com períodos mensal/anual e filtros por paciente e estado pago/pendente;
- datas previstas, pagamento em atraso e passagem rápida para pago;
- agenda diária, semanal e mensal, aviso de sobreposição e criação de sessão a partir da marcação;
- duplicação de sessão, reavaliação associada, extrato imprimível e Excel filtrado;
- eliminação para a reciclagem e recuperação integral do registo;
- exportação de backup integral, abertura numa base vazia e restauro com contagens iguais;
- exportação de um livro Excel `.xlsx` válido com sete folhas clínicas e administrativas, incluindo Pacotes;
- abertura independente do Excel, confirmação dos dados, estilos, datas, valores monetários e revisão visual de todas as folhas;
- recarregamento offline através do service worker.

## Dados do percurso automatizado

| Tipo | Antes do backup | Depois do restauro |
| --- | ---: | ---: |
| Pacientes | 4 | 4 |
| Marcações | 3 | 3 |
| Pacotes | 2 | 2 |
| Sessões | 2 | 2 |
| Avaliações | 2 | 2 |
| Recebimentos | 4 | 4 |

## Limite desta validação

Não foi possível executar o teste final num iPhone físico nem no Safari do macOS neste computador Windows. Antes de usar dados reais, deve ser feito um ensaio com dados fictícios nos dois dispositivos, incluindo instalação pelo Safari, funcionamento offline, exportação JSON e Excel no iPhone e restauro do JSON no MacBook.

