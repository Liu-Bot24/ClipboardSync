#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <netdb.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define BUFFER_SIZE 65536

typedef struct {
  int client_fd;
  char target_host[256];
  char target_port[16];
} connection_t;

static char *read_file(const char *path) {
  FILE *file = fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "config open failed: %s: %s\n", path, strerror(errno));
    return NULL;
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  char *buffer = calloc((size_t)size + 1, 1);
  if (!buffer) {
    fclose(file);
    return NULL;
  }
  if (fread(buffer, 1, (size_t)size, file) != (size_t)size) {
    free(buffer);
    fclose(file);
    return NULL;
  }
  fclose(file);
  return buffer;
}

static const char *skip_space(const char *value) {
  while (*value && isspace((unsigned char)*value)) {
    value++;
  }
  return value;
}

static int json_string(const char *json, const char *key, char *out, size_t out_size) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *pos = strstr(json, needle);
  if (!pos) {
    return 0;
  }
  pos = strchr(pos + strlen(needle), ':');
  if (!pos) {
    return 0;
  }
  pos = skip_space(pos + 1);
  if (*pos != '"') {
    return 0;
  }
  pos++;
  size_t i = 0;
  while (*pos && *pos != '"' && i + 1 < out_size) {
    out[i++] = *pos++;
  }
  out[i] = '\0';
  return i > 0;
}

static int json_int(const char *json, const char *key, int fallback) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *pos = strstr(json, needle);
  if (!pos) {
    return fallback;
  }
  pos = strchr(pos + strlen(needle), ':');
  if (!pos) {
    return fallback;
  }
  pos = skip_space(pos + 1);
  if (!isdigit((unsigned char)*pos)) {
    return fallback;
  }
  return atoi(pos);
}

static int parse_target_url(const char *url, char *host, size_t host_size, char *port, size_t port_size) {
  const char *start = url;
  const char *default_port = "80";
  if (strncmp(start, "http://", 7) == 0) {
    start += 7;
    default_port = "80";
  } else if (strncmp(start, "https://", 8) == 0) {
    start += 8;
    default_port = "443";
  }

  const char *end = start;
  while (*end && *end != '/' && *end != ':') {
    end++;
  }
  size_t host_len = (size_t)(end - start);
  if (host_len == 0 || host_len >= host_size) {
    return 0;
  }
  memcpy(host, start, host_len);
  host[host_len] = '\0';

  if (*end == ':') {
    const char *port_start = end + 1;
    const char *port_end = port_start;
    while (*port_end && *port_end != '/') {
      port_end++;
    }
    size_t port_len = (size_t)(port_end - port_start);
    if (port_len == 0 || port_len >= port_size) {
      return 0;
    }
    memcpy(port, port_start, port_len);
    port[port_len] = '\0';
  } else {
    snprintf(port, port_size, "%s", default_port);
  }
  return 1;
}

static int connect_to_host(const char *host, const char *port) {
  struct addrinfo hints;
  struct addrinfo *result = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;

  int status = getaddrinfo(host, port, &hints, &result);
  if (status != 0) {
    fprintf(stderr, "target resolve failed: %s:%s: %s\n", host, port, gai_strerror(status));
    return -1;
  }

  int fd = -1;
  for (struct addrinfo *item = result; item; item = item->ai_next) {
    fd = socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (fd < 0) {
      continue;
    }
    if (connect(fd, item->ai_addr, item->ai_addrlen) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(result);
  if (fd < 0) {
    fprintf(stderr, "target connect failed: %s:%s: %s\n", host, port, strerror(errno));
  }
  return fd;
}

static int write_all(int fd, const char *buffer, ssize_t length) {
  ssize_t written = 0;
  while (written < length) {
    ssize_t result = write(fd, buffer + written, (size_t)(length - written));
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 0;
    }
    if (result == 0) {
      return 0;
    }
    written += result;
  }
  return 1;
}

static void close_pair(int a, int b) {
  if (a >= 0) {
    close(a);
  }
  if (b >= 0) {
    close(b);
  }
}

static void *handle_connection(void *arg) {
  connection_t *connection = (connection_t *)arg;
  int client_fd = connection->client_fd;
  int upstream_fd = connect_to_host(connection->target_host, connection->target_port);
  free(connection);
  if (upstream_fd < 0) {
    close(client_fd);
    return NULL;
  }

  char buffer[BUFFER_SIZE];
  struct pollfd fds[2];
  fds[0].fd = client_fd;
  fds[0].events = POLLIN;
  fds[1].fd = upstream_fd;
  fds[1].events = POLLIN;

  while (1) {
    int ready = poll(fds, 2, -1);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    for (int i = 0; i < 2; i++) {
      if (fds[i].revents & POLLIN) {
        int from = fds[i].fd;
        int to = fds[i == 0 ? 1 : 0].fd;
        ssize_t bytes = read(from, buffer, sizeof(buffer));
        if (bytes <= 0 || !write_all(to, buffer, bytes)) {
          close_pair(client_fd, upstream_fd);
          return NULL;
        }
      }
      if (fds[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
        close_pair(client_fd, upstream_fd);
        return NULL;
      }
    }
  }

  close_pair(client_fd, upstream_fd);
  return NULL;
}

static int create_listener(const char *host, const char *port) {
  struct addrinfo hints;
  struct addrinfo *result = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  hints.ai_flags = AI_PASSIVE;

  int status = getaddrinfo(host, port, &hints, &result);
  if (status != 0) {
    fprintf(stderr, "listen resolve failed: %s:%s: %s\n", host, port, gai_strerror(status));
    return -1;
  }

  int fd = -1;
  for (struct addrinfo *item = result; item; item = item->ai_next) {
    fd = socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (fd < 0) {
      continue;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    if (bind(fd, item->ai_addr, item->ai_addrlen) == 0 && listen(fd, 128) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(result);
  if (fd < 0) {
    fprintf(stderr, "listen failed: %s:%s: %s\n", host, port, strerror(errno));
  }
  return fd;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);

  char listen_host[256] = "127.0.0.1";
  char listen_port[16] = "18787";
  char target_host[256] = "";
  char target_port[16] = "";

  if (argc == 5) {
    snprintf(listen_host, sizeof(listen_host), "%s", argv[1]);
    snprintf(listen_port, sizeof(listen_port), "%s", argv[2]);
    snprintf(target_host, sizeof(target_host), "%s", argv[3]);
    snprintf(target_port, sizeof(target_port), "%s", argv[4]);
  } else {
    const char *config_path = getenv("CLIPBOARD_SYNC_PROXY_CONFIG");
    if (config_path && *config_path) {
      char *json = read_file(config_path);
      if (!json) {
        return 1;
      }
      char target_url[512] = "";
      json_string(json, "listenHost", listen_host, sizeof(listen_host));
      snprintf(listen_port, sizeof(listen_port), "%d", json_int(json, "listenPort", 18787));
      if (json_string(json, "targetUrl", target_url, sizeof(target_url))) {
        if (!parse_target_url(target_url, target_host, sizeof(target_host), target_port, sizeof(target_port))) {
          fprintf(stderr, "targetUrl parse failed: %s\n", target_url);
          free(json);
          return 1;
        }
      }
      free(json);
    }
  }

  if (target_host[0] == '\0' || target_port[0] == '\0') {
    fprintf(stderr, "targetUrl is required in CLIPBOARD_SYNC_PROXY_CONFIG or argv\n");
    return 1;
  }

  int listener = create_listener(listen_host, listen_port);
  if (listener < 0) {
    return 1;
  }

  printf("clipboard local proxy listening on %s:%s -> %s:%s\n", listen_host, listen_port, target_host, target_port);
  fflush(stdout);

  while (1) {
    int client_fd = accept(listener, NULL, NULL);
    if (client_fd < 0) {
      if (errno == EINTR) {
        continue;
      }
      fprintf(stderr, "accept failed: %s\n", strerror(errno));
      continue;
    }

    connection_t *connection = calloc(1, sizeof(connection_t));
    if (!connection) {
      close(client_fd);
      continue;
    }
    connection->client_fd = client_fd;
    snprintf(connection->target_host, sizeof(connection->target_host), "%s", target_host);
    snprintf(connection->target_port, sizeof(connection->target_port), "%s", target_port);

    pthread_t thread;
    if (pthread_create(&thread, NULL, handle_connection, connection) != 0) {
      close(client_fd);
      free(connection);
      continue;
    }
    pthread_detach(thread);
  }
}
