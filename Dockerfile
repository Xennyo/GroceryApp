# Un seul service : il sert l'application et la synchronisation.
FROM node:22-alpine

WORKDIR /app
COPY . .

# Les espaces vivent ici. Sur un hébergeur au disque éphémère, monter un
# volume sur ce chemin — sinon tout disparaît au premier redéploiement.
ENV DONNEES=/donnees
RUN mkdir -p /donnees

ENV PORT=8787
EXPOSE 8787

# Pas de dépendance à installer : le serveur n'utilise que Node.
CMD ["sh", "-c", "node serveur/serveur.js --port ${PORT} --donnees ${DONNEES} --statique ."]
